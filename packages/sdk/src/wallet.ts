import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WASM_OWNER,
  DEFAULT_WASM_PROJECT,
  WRITE_DEPOSIT,
  WRITE_GAS,
} from './constants';
import {
  authError,
  insufficientBalanceError,
  networkError,
  protocolError,
} from './errors';
import type { FetchLike } from './read';
import type { VrfProof } from './types';

/**
 * Response from OutLayer `POST /register`. Required fields are load-bearing
 * for constructing a `NearlyClient`; optional fields (`handoffUrl`,
 * `trial.expires_at`) are surfaced when OutLayer returns them so consumers
 * can deep-link the hosted wallet-management UI or warn on trial-window
 * expiry. See `frontend/src/lib/outlayer.ts::OutlayerRegisterResponse` for
 * the full documented wire (verified against production 2026-04-14) —
 * `wallet_id` and `trial.limits.*` are on the wire but not typed here yet.
 */
export interface RegisterResponse {
  walletKey: string;
  accountId: string;
  handoffUrl?: string;
  trial: {
    calls_remaining: number;
    expires_at?: string;
  };
}

/**
 * Response from OutLayer `GET /wallet/v1/balance?chain=<chain>`. `balance`
 * is the chain-native minimum unit as a decimal string (yoctoNEAR for
 * NEAR, wei for EVM chains); `balanceNear` is the derived NEAR-denominated
 * float, populated only when `chain === 'near'` and left undefined
 * otherwise. `accountId` is the custody wallet's canonical account — the
 * same 64-hex implicit account returned by `/register`, so this endpoint
 * doubles as a "who am I?" discovery path that does not require
 * sign-message (per agent-custody skill docs).
 */
export interface BalanceResponse {
  accountId: string;
  chain: string;
  balance: string;
  balanceNear?: number;
}

export interface WalletClient {
  outlayerUrl: string;
  namespace: string;
  walletKey: string;
  fetch: FetchLike;
  timeoutMs: number;
  wasmOwner: string;
  wasmProject: string;
}

/**
 * NEP-413 envelope returned by OutLayer `POST /wallet/v1/sign-message`.
 * Mirrors the wire shape parsed in `frontend/src/lib/outlayer-server.ts::signMessage`
 * (confirmed 2026-04-04). `nonce` is OutLayer-generated, single-use per
 * recipient. `message` is echoed back by the caller since OutLayer does not
 * return it — it's the exact string that was signed.
 */
export interface SignedClaim {
  accountId: string;
  publicKey: string;
  signature: string;
  nonce: string;
  message: string;
}

export function createWalletClient(opts: {
  outlayerUrl: string;
  namespace: string;
  walletKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  wasmOwner?: string;
  wasmProject?: string;
}): WalletClient {
  return {
    outlayerUrl: opts.outlayerUrl,
    namespace: opts.namespace,
    walletKey: opts.walletKey,
    fetch: opts.fetch ?? (globalThis.fetch as FetchLike),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    wasmOwner: opts.wasmOwner ?? DEFAULT_WASM_OWNER,
    wasmProject: opts.wasmProject ?? DEFAULT_WASM_PROJECT,
  };
}

/**
 * Submit a FastData KV write via OutLayer's custody wallet. The wk_ key
 * determines the predecessor server-side — no accountId travels on the wire.
 * Throws NearlyError on failure; resolves silently on success (caller reads
 * back if it needs to confirm landing).
 */
export async function submitWrite(
  client: WalletClient,
  entries: Record<string, unknown>,
): Promise<void> {
  const url = `${client.outlayerUrl}/wallet/v1/call`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.walletKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receiver_id: client.namespace,
        method_name: '__fastdata_kv',
        args: entries,
        gas: WRITE_GAS,
        deposit: WRITE_DEPOSIT,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) return;

  if (res.status === 401 || res.status === 403) {
    throw authError(`OutLayer rejected credentials (${res.status})`);
  }
  // Zero-balance writes return 502 + text/plain (Cloudflare upstream).
  if (res.status === 502) {
    throw insufficientBalanceError('0.01', '0');
  }
  const detail = await res.text().catch(() => '');
  throw protocolError(
    `submitWrite ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
  );
}

/**
 * Provision a fresh OutLayer custody wallet via `POST /register`. This is an
 * unauthenticated call — no `wk_` travels on the wire, and the SDK doesn't
 * consult its rate limiter (OutLayer owns its own rate limit for the
 * provisioning path). Returns the minimum credentials needed to construct a
 * `NearlyClient`: `walletKey`, `accountId`, and the `trial` quota object.
 *
 * Errors:
 * - Network/timeout → `networkError`
 * - 401/403 → `authError` (protocol anomaly — register is unauth)
 * - Other non-2xx → `protocolError` with truncated body
 * - Non-JSON 2xx → `protocolError`
 * - Missing `api_key` / `near_account_id` / `trial` → `protocolError`
 *
 * Internal to wallet.ts — the public entry point is `NearlyClient.register`.
 */
export async function registerWallet(opts: {
  outlayerUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<RegisterResponse> {
  const fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.outlayerUrl}/register`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected register (${res.status})`);
    }
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `register ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('register: malformed JSON in 2xx response');
  }

  if (!body || typeof body !== 'object') {
    throw protocolError('register: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  const apiKey = b.api_key;
  const accountId = b.near_account_id;
  const trial = b.trial;
  const handoffUrl = b.handoff_url;

  if (typeof apiKey !== 'string' || !apiKey) {
    throw protocolError('register: response missing api_key');
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw protocolError('register: response missing near_account_id');
  }
  if (
    !trial ||
    typeof trial !== 'object' ||
    typeof (trial as { calls_remaining?: unknown }).calls_remaining !== 'number'
  ) {
    throw protocolError('register: response missing trial.calls_remaining');
  }

  const trialExpiresAt = (trial as { expires_at?: unknown }).expires_at;

  return {
    walletKey: apiKey,
    accountId,
    ...(typeof handoffUrl === 'string' && handoffUrl ? { handoffUrl } : {}),
    trial: {
      calls_remaining: (trial as { calls_remaining: number }).calls_remaining,
      ...(typeof trialExpiresAt === 'string' && trialExpiresAt
        ? { expires_at: trialExpiresAt }
        : {}),
    },
  };
}

/**
 * Read the caller's custody wallet balance for a given chain. Defaults
 * to `near`. Returns the chain-native minimum-unit balance plus (for
 * NEAR) the derived float for display. Missing fields in the 2xx body
 * surface as `protocolError`, not silent zeros — silent zeros would
 * mislead a caller into thinking their funded wallet was empty.
 *
 * Internal to wallet.ts — the public entry point is
 * `NearlyClient.getBalance`.
 */
export async function getWalletBalance(
  client: WalletClient,
  opts: { chain?: string } = {},
): Promise<BalanceResponse> {
  const chain = opts.chain ?? 'near';
  const url = `${client.outlayerUrl}/wallet/v1/balance?chain=${encodeURIComponent(chain)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${client.walletKey}` },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected credentials (${res.status})`);
    }
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `getBalance ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('getBalance: malformed JSON in 2xx response');
  }
  if (!body || typeof body !== 'object') {
    throw protocolError('getBalance: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  const balance = b.balance;
  const accountId = b.account_id;
  if (typeof balance !== 'string' || !balance) {
    throw protocolError('getBalance: response missing balance');
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw protocolError('getBalance: response missing account_id');
  }

  // For NEAR, surface the human-readable float alongside the raw yocto
  // string. Clients that want exact precision still have `balance` as
  // the source of truth; clients that want "0.009393 NEAR" for display
  // get it without parsing yocto themselves.
  let balanceNear: number | undefined;
  if (chain === 'near') {
    // 1 NEAR = 1e24 yoctoNEAR. Two-stage BigInt divide to pico (1e-12),
    // then a single float divide to NEAR. Stays safely under JS's
    // 2^53 integer precision cap for balances up to ~9 million NEAR
    // (Number.MAX_SAFE_INTEGER / 1e6 pico per NEAR), which covers every
    // realistic custody wallet. Keeps 12 decimal places of precision.
    try {
      const pico = Number(BigInt(balance) / BigInt('1000000000000'));
      const asNum = pico / 1e12;
      if (Number.isFinite(asNum)) balanceNear = asNum;
    } catch {
      // BigInt() throws on non-numeric strings. Leave balanceNear
      // undefined; the raw `balance` string is still returned.
    }
  }

  return { accountId, chain, balance, balanceNear };
}

const CLAIM_DOMAIN = 'nearly.social';
const CLAIM_VERSION = 1;

/**
 * Build the canonical NEP-413 claim message the Nearly WASM expects. Matches
 * `frontend/src/lib/outlayer-server.ts::buildClaimMessage` verbatim — the
 * WASM validates the exact JSON shape server-side, so any drift breaks
 * verification.
 */
export function buildClaimMessage(action: string, accountId: string): string {
  return JSON.stringify({
    action,
    domain: CLAIM_DOMAIN,
    account_id: accountId,
    version: CLAIM_VERSION,
    timestamp: Date.now(),
  });
}

/**
 * Ask OutLayer to NEP-413 sign a message for this wallet key. Thin wrapper
 * over `POST /wallet/v1/sign-message`. Returns a `SignedClaim` envelope
 * (account_id, public_key, signature, nonce, message) ready to forward as
 * `verifiable_claim` to the WASM `/call` endpoint.
 *
 * Errors:
 * - Network/timeout → `networkError`
 * - 401/403 → `authError`
 * - Other non-2xx → `protocolError`
 * - Non-JSON or missing fields → `protocolError`
 *
 * Internal to wallet.ts — the public entry point is
 * `NearlyClient.getSuggested` (for the `get_vrf_seed` action) or a caller
 * who composes it themselves via `execute` + `callOutlayer`.
 */
export async function signClaim(
  client: WalletClient,
  action: string,
  accountId: string,
): Promise<SignedClaim> {
  const message = buildClaimMessage(action, accountId);
  const url = `${client.outlayerUrl}/wallet/v1/sign-message`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.walletKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, recipient: CLAIM_DOMAIN }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected sign-message (${res.status})`);
    }
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `signClaim ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('signClaim: malformed JSON in 2xx response');
  }
  if (!body || typeof body !== 'object') {
    throw protocolError('signClaim: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.account_id !== 'string' ||
    typeof b.public_key !== 'string' ||
    typeof b.signature !== 'string' ||
    typeof b.nonce !== 'string'
  ) {
    throw protocolError('signClaim: response missing claim fields');
  }
  return {
    accountId: b.account_id,
    publicKey: b.public_key,
    signature: b.signature,
    nonce: b.nonce,
    message,
  };
}

/**
 * OutLayer resource limits copied verbatim from
 * `frontend/src/lib/outlayer-server.ts`. Keeping them as a constant here
 * means the SDK's WASM calls are gas-equivalent to the proxy's — divergent
 * limits would surface as mysterious execution failures on one path but not
 * the other.
 */
const OUTLAYER_RESOURCE_LIMITS = {
  max_instructions: 2_000_000_000,
  max_memory_mb: 512,
  max_execution_seconds: 30,
} as const;

/**
 * Decoded WASM response envelope. Matches `WasmResponse` in
 * `frontend/src/lib/outlayer-server.ts` — `success`, optional `data`,
 * and error metadata on failures. Callers narrow `data` themselves.
 */
export interface WasmResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  hint?: string;
  retry_after?: number;
}

function isWasmResponse(v: unknown): v is WasmResponse {
  if (typeof v !== 'object' || v === null || !('success' in v)) return false;
  return typeof (v as { success: unknown }).success === 'boolean';
}

/**
 * Decode the OutLayer `/call` response into a WASM envelope. Handles the
 * three shapes documented in `outlayer-server.ts::decodeOutlayerResponse`:
 *
 * 1. Top-level `{success, data, ...}` — passed through.
 * 2. `{output: "<base64-json>"}` — decode base64, parse JSON, unwrap.
 * 3. Raw base64 string — decode, parse, unwrap.
 *
 * Throws `protocolError` on any shape the decoder can't recognize.
 */
function decodeWasmResponse(result: unknown): WasmResponse {
  if (typeof result === 'string') {
    let decoded: string;
    try {
      decoded = atob(result);
    } catch {
      throw protocolError('callOutlayer: invalid base64 in response');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw protocolError('callOutlayer: invalid JSON in base64 payload');
    }
    if (isWasmResponse(parsed)) return parsed;
    throw protocolError('callOutlayer: decoded body is not a WASM response');
  }

  if (typeof result !== 'object' || result === null) {
    throw protocolError('callOutlayer: unexpected response type');
  }

  const r = result as Record<string, unknown>;
  if (r.output !== undefined) {
    let decoded: unknown;
    try {
      decoded =
        typeof r.output === 'string' ? JSON.parse(atob(r.output)) : r.output;
    } catch {
      throw protocolError('callOutlayer: invalid base64 in output field');
    }
    if (isWasmResponse(decoded)) return decoded;
    throw protocolError('callOutlayer: output field is not a WASM response');
  }

  if (isWasmResponse(r)) return r;
  throw protocolError('callOutlayer: response missing success flag');
}

/**
 * Call a Nearly WASM action via OutLayer `POST /call/{owner}/{project}`.
 * Mirrors `frontend/src/lib/outlayer-server.ts::callOutlayer` — the wire
 * body is `{input: <wasmBody>, resource_limits: {...}}` with the fixed
 * OutLayer resource limits, and the response is decoded into a uniform
 * `WasmResponse` envelope regardless of whether the top-level shape is
 * raw, `{output}`, or a base64 string.
 *
 * The caller passes the action name (snake_case, not CamelCase — the WASM
 * matches on the string verbatim) plus any payload fields including a
 * `verifiable_claim` when the action requires one. Auth: `wk_` keys go in
 * `Authorization: Bearer`, anything else (payment key) goes in
 * `X-Payment-Key`, matching the proxy's branching.
 *
 * Returns the decoded `WasmResponse`. Does not throw on `success: false` —
 * callers inspect the envelope and decide.
 *
 * Errors:
 * - Network / timeout → `networkError`
 * - 401/403 → `authError`
 * - 402 / 502 → `insufficientBalanceError` (OutLayer quota exhausted)
 * - Other non-2xx → `protocolError`
 * - Unparseable response → `protocolError`
 */
export async function callOutlayer(
  client: WalletClient,
  wasmBody: Record<string, unknown>,
): Promise<WasmResponse> {
  const url = `${client.outlayerUrl}/call/${client.wasmOwner}/${client.wasmProject}`;
  const isWalletKey = client.walletKey.startsWith('wk_');
  const authHeaders: Record<string, string> = isWalletKey
    ? { Authorization: `Bearer ${client.walletKey}` }
    : { 'X-Payment-Key': client.walletKey };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        input: wasmBody,
        resource_limits: OUTLAYER_RESOURCE_LIMITS,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected credentials (${res.status})`);
    }
    if (res.status === 402 || res.status === 502) {
      throw insufficientBalanceError('0.01', '0');
    }
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `callOutlayer ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let result: unknown;
  try {
    result = await res.json();
  } catch {
    throw protocolError('callOutlayer: malformed JSON in 2xx response');
  }

  // OutLayer signals WASM execution failures with `status: "failed"` at the
  // top level (pre-decode). Mirrors `outlayer-server.ts` handling.
  if (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'failed'
  ) {
    throw protocolError('callOutlayer: WASM execution failed');
  }

  return decodeWasmResponse(result);
}

/**
 * Mint a VRF proof from the Nearly WASM TEE. Composes `signClaim` +
 * `callOutlayer`: signs a `get_vrf_seed` NEP-413 claim, forwards it as
 * `verifiable_claim` to the WASM, and parses the returned proof. Returns
 * null when the WASM responds with `success: false` so callers can fall
 * through to a deterministic (non-shuffled) rank — matches the proxy's
 * `handleAuthenticatedGet` tolerance for VRF failures.
 */
export async function getVrfSeed(
  client: WalletClient,
  accountId: string,
): Promise<VrfProof | null> {
  const claim = await signClaim(client, 'get_vrf_seed', accountId);
  const decoded = await callOutlayer(client, {
    action: 'get_vrf_seed',
    verifiable_claim: {
      account_id: claim.accountId,
      public_key: claim.publicKey,
      signature: claim.signature,
      nonce: claim.nonce,
      message: claim.message,
    },
  });
  if (!decoded.success) return null;
  const d = decoded.data as Record<string, unknown> | undefined;
  if (
    !d ||
    typeof d.output_hex !== 'string' ||
    typeof d.signature_hex !== 'string' ||
    typeof d.alpha !== 'string' ||
    typeof d.vrf_public_key !== 'string'
  ) {
    throw protocolError('getVrfSeed: response missing VrfProof fields');
  }
  return {
    output_hex: d.output_hex,
    signature_hex: d.signature_hex,
    alpha: d.alpha,
    vrf_public_key: d.vrf_public_key,
  };
}

/**
 * SHA256 a string, return the digest as a 64-char lowercase hex string.
 * Uses the Web Crypto API (`globalThis.crypto.subtle`), which is available
 * natively in Node 18+ and every modern browser — no `node:crypto` import,
 * no Buffer, no deps. Single code path for browser + Node.
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive a deterministic sub-agent custody wallet key from a parent `wk_`
 * key and a caller-chosen seed. Pure — no I/O, no state. The formula
 * comes from the agent-custody skill's "From a custody wallet" example:
 *
 *   sub_key  = "wk_" + sha256_hex(f"{seed}:0:{parent_key}")
 *   key_hash =         sha256_hex(sub_key)
 *
 * Returns the derived `subKey` (the sub-agent's `wk_` bearer token) and
 * its `keyHash` (the SHA256 hex of `subKey`, which the parent registers
 * against OutLayer via `PUT /wallet/v1/api-key`). Same inputs always
 * produce the same outputs — `(parentKey, seed)` is the wallet identity,
 * so re-derivation is a valid alternative to persistence.
 *
 * The `:0:` separator is a literal from the skill example. A seed
 * containing `:0:` could theoretically collide with another seed/parent
 * pair, but collision handling is OutLayer's concern server-side, not
 * the SDK's.
 */
export async function deriveSubAgentKey(
  parentKey: string,
  seed: string,
): Promise<{ subKey: string; keyHash: string }> {
  const subKey = `wk_${await sha256Hex(`${seed}:0:${parentKey}`)}`;
  const keyHash = await sha256Hex(subKey);
  return { subKey, keyHash };
}

/**
 * Register a sub-agent key hash with OutLayer at `PUT /wallet/v1/api-key`,
 * authenticating as the parent custody wallet. Creates the sub-wallet if
 * it doesn't exist yet; idempotent across calls with the same
 * `(seed, key_hash)` pair. The parent's Bearer token is the only auth;
 * no NEAR-key signing is required since the parent is already a custody
 * wallet.
 *
 * Errors:
 * - Network/timeout → `networkError`
 * - 401/403 → `authError` (parent `wk_` rejected)
 * - Other non-2xx → `protocolError` with truncated body
 * - Non-JSON 2xx → `protocolError`
 * - Missing `near_account_id` in response → `protocolError`
 *
 * Internal to wallet.ts — the public entry point is
 * `NearlyClient.deriveSubAgent`.
 */
export async function registerSubAgentKey(opts: {
  outlayerUrl: string;
  parentKey: string;
  seed: string;
  keyHash: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<{ accountId: string; walletId: string | undefined }> {
  const fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.outlayerUrl}/wallet/v1/api-key`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${opts.parentKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seed: opts.seed, key_hash: opts.keyHash }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected parent credentials (${res.status})`);
    }
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `api-key ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('api-key: malformed JSON in 2xx response');
  }
  if (!body || typeof body !== 'object') {
    throw protocolError('api-key: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  const accountId = b.near_account_id;
  const walletId = b.wallet_id;

  if (typeof accountId !== 'string' || !accountId) {
    throw protocolError('api-key: response missing near_account_id');
  }

  return {
    accountId,
    walletId: typeof walletId === 'string' ? walletId : undefined,
  };
}
