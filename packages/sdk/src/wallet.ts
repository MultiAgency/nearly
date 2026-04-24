import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WASM_OWNER,
  DEFAULT_WASM_PROJECT,
  WRITE_DEPOSIT,
  WRITE_GAS,
} from './constants';
import {
  encodeEd25519PublicKey,
  encodeSignatureBase58,
  parseEd25519SecretKey,
  signRegisterMessage,
} from './ed25519';
import { bytesToHex, hmacSha256, sha256 } from './hashes';
import {
  authError,
  insufficientBalanceError,
  networkError,
  protocolError,
  validationError,
} from './errors';
import type { FetchLike } from './read';
import type { VerifiableClaim } from './types';

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
  /**
   * Default domain for NEP-413 structured claims signed via `signClaim`
   * in `./claim`. Required, no primitive-layer default — callers must
   * choose explicitly. `NearlyClient` injects `'nearly.social'` at
   * construction; other convention callers inject their own.
   */
  claimDomain: string;
  /**
   * Default version for NEP-413 structured claims signed via `signClaim`
   * in `./claim`. Required for the same reason as `claimDomain`.
   */
  claimVersion: number;
}

export function createWalletClient(opts: {
  outlayerUrl: string;
  namespace: string;
  walletKey: string;
  claimDomain: string;
  claimVersion: number;
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
    claimDomain: opts.claimDomain,
    claimVersion: opts.claimVersion,
  };
}

/**
 * Submit a FastData KV write via OutLayer's custody wallet. The wk_ key
 * determines the predecessor server-side — no accountId travels on the wire.
 * Throws NearlyError on failure; resolves silently on success (caller reads
 * back if it needs to confirm landing).
 */
export async function writeEntries(
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
    `writeEntries ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
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
export async function createWallet(opts: {
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
 * Response from OutLayer `POST /register` when the request carries a
 * NEAR-signature body — the "deterministic wallet" flow. The returned
 * `nearAccountId` is the **derived hex64 implicit account** for the
 * wallet keyed on (caller's `accountId`, `seed`); it is NOT the caller's
 * named NEAR account. No `walletKey` is issued: the caller is expected
 * to continue authenticating via `Bearer near:` tokens they sign with
 * the same NEAR key, or to manage the wallet out-of-band. Nearly itself
 * does not retain either the derived wallet or the caller's NEAR key.
 */
export interface DeterministicRegisterResponse {
  walletId: string;
  nearAccountId: string;
  handoffUrl?: string;
  /**
   * Trial quota. Optional — OutLayer omits it on the idempotent
   * re-registration response for an already-derived wallet.
   */
  trial?: {
    calls_remaining: number;
    expires_at?: string;
  };
}

/**
 * Provision a deterministic custody wallet via `POST /register` with a
 * NEAR-signature body. The caller holds their own NEAR ed25519 private
 * key; this helper signs `register:<seed>:<unix_ts>` locally, posts the
 * `{account_id, seed, pubkey, message, signature}` body, and returns the
 * derived wallet identity OutLayer settles on.
 *
 * `accountId` is the caller's named NEAR account (e.g. `alice.near`);
 * the derived wallet's on-chain identity returned as `nearAccountId` is
 * a hex64 implicit account keyed on `(accountId, seed)`. Same inputs →
 * same wallet (OutLayer's idempotency contract). Different identities;
 * callers who need the named account as the on-chain writer cannot get
 * that through this path — OutLayer's derivation layer owns that
 * semantic.
 *
 * The SDK never persists the caller's `privateKey`. It lives in memory
 * for the duration of the call, is used to compute the signature, and
 * is not logged or surfaced in any error. Callers are responsible for
 * sourcing the key safely (file, env, KMS) and for passing it in opts
 * rather than through credentials storage.
 *
 * Errors:
 * - Invalid `privateKey` format → `validationError` from
 *   `parseEd25519SecretKey`.
 * - Empty / missing `accountId`, `seed` → `validationError`.
 * - Network / timeout → `networkError`.
 * - 401/403 → `authError` (deterministic register is authenticated by
 *   the signature body — rejections mean the signature did not verify).
 * - Other non-2xx → `protocolError` with truncated body.
 * - Non-JSON 2xx / missing fields → `protocolError`.
 */
export async function createDeterministicWallet(opts: {
  outlayerUrl: string;
  accountId: string;
  seed: string;
  privateKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}): Promise<DeterministicRegisterResponse> {
  if (typeof opts.accountId !== 'string' || !opts.accountId) {
    throw validationError('accountId', 'accountId is required');
  }
  if (typeof opts.seed !== 'string' || !opts.seed) {
    throw validationError('seed', 'seed is required');
  }

  const parsed = parseEd25519SecretKey(opts.privateKey);
  const unixSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const message = `register:${opts.seed}:${unixSeconds}`;
  const signature = signRegisterMessage(message, parsed.secretKey);

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
      body: JSON.stringify({
        account_id: opts.accountId,
        seed: opts.seed,
        pubkey: encodeEd25519PublicKey(parsed.publicKey),
        message,
        signature: encodeSignatureBase58(signature),
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
      throw authError(
        `OutLayer rejected deterministic register (${res.status})`,
      );
    }
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `deterministic register ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError(
      'deterministic register: malformed JSON in 2xx response',
    );
  }
  if (!body || typeof body !== 'object') {
    throw protocolError(
      'deterministic register: response body is not an object',
    );
  }
  const b = body as Record<string, unknown>;
  const walletId = b.wallet_id;
  const nearAccountId = b.near_account_id;
  const trial = b.trial;
  const handoffUrl = b.handoff_url;

  if (typeof walletId !== 'string' || !walletId) {
    throw protocolError('deterministic register: response missing wallet_id');
  }
  if (typeof nearAccountId !== 'string' || !nearAccountId) {
    throw protocolError(
      'deterministic register: response missing near_account_id',
    );
  }
  let normalizedTrial: DeterministicRegisterResponse['trial'];
  if (trial !== undefined && trial !== null) {
    if (
      typeof trial !== 'object' ||
      typeof (trial as { calls_remaining?: unknown }).calls_remaining !==
        'number'
    ) {
      throw protocolError(
        'deterministic register: trial present but missing calls_remaining',
      );
    }
    const trialExpiresAt = (trial as { expires_at?: unknown }).expires_at;
    normalizedTrial = {
      calls_remaining: (trial as { calls_remaining: number }).calls_remaining,
      ...(typeof trialExpiresAt === 'string' && trialExpiresAt
        ? { expires_at: trialExpiresAt }
        : {}),
    };
  }

  return {
    walletId,
    nearAccountId,
    ...(typeof handoffUrl === 'string' && handoffUrl ? { handoffUrl } : {}),
    ...(normalizedTrial ? { trial: normalizedTrial } : {}),
  };
}

/**
 * Response from OutLayer `PUT /wallet/v1/api-key` when the request carries
 * a NEAR-signature body — the "delegate key for a deterministic wallet"
 * flow. The returned `walletKey` is the client-derived `wk_` (its hash was
 * sent to OutLayer, never the key itself), and the returned `nearAccountId`
 * is the derived hex64 implicit account — the same one `createDeterministicWallet`
 * produces for `(accountId, seed)`.
 */
export interface MintDelegateKeyResponse {
  walletId: string;
  nearAccountId: string;
  /**
   * The client-derived `wk_` key. OutLayer never sees this value directly —
   * only its SHA-256 hash travels on the wire. Save it or hand it to an
   * `ApiClient`; it is the caller's only mutable credential for the derived
   * wallet.
   */
  walletKey: string;
}

/**
 * Mint a delegate `wk_` key for a deterministic wallet via
 * `PUT /wallet/v1/api-key` with a NEAR-signature body. Same shape as
 * `createDeterministicWallet` at the auth layer (the caller's NEAR key
 * signs the request); different outcome — this produces a `wk_` usable
 * against OutLayer's `Bearer wk_...` endpoints, which is what the
 * existing Nearly write path expects.
 *
 * **Derivation.** The `wk_` is computed locally as
 * `"wk_" + hex(HMAC-SHA256(seed_bytes, "<seed>:<keyIndex>"))`, where
 * `seed_bytes` is the 32-byte ed25519 seed (first half of tweetnacl's
 * 64-byte secretKey). OutLayer only learns `sha256(wk_...)` — the key
 * itself stays client-side. See agent-custody SKILL.md §"Register delegate
 * key for sub-agents".
 *
 * **Idempotency.** Same inputs produce the same `wk_`; `PUT` semantics
 * mean calling twice with the same `(accountId, seed, keyIndex)` registers
 * the same hash twice (OutLayer returns the same wallet identity). Useful
 * for recovery — a caller who lost the `wk_` but kept their NEAR key can
 * re-derive it without re-registering.
 *
 * **Async divergence flag.** Unlike `ed25519.ts`'s sync signing primitives,
 * this function's internal hash operations (HMAC-SHA256 + SHA-256) are
 * async — `SubtleCrypto` in the browser is promise-returning, and the
 * shim in `./hashes.ts` harmonizes Node and browser to the same async
 * shape. Callers must `await` accordingly; no sync entry point is provided.
 *
 * Errors:
 * - Invalid `privateKey` format → `validationError` from
 *   `parseEd25519SecretKey`.
 * - Empty / missing `accountId`, `seed` → `validationError`.
 * - Network / timeout → `networkError`.
 * - 401/403 → `authError` (signature verification failure).
 * - 409 → `protocolError` (OutLayer reports if the last active key for
 *   the wallet would be revoked — not expected on creation, handled
 *   defensively).
 * - Other non-2xx → `protocolError` with truncated body.
 * - Non-JSON 2xx / missing fields → `protocolError`.
 */
export async function mintDelegateKey(opts: {
  outlayerUrl: string;
  accountId: string;
  seed: string;
  privateKey: string;
  keyIndex?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}): Promise<MintDelegateKeyResponse> {
  if (typeof opts.accountId !== 'string' || !opts.accountId) {
    throw validationError('accountId', 'accountId is required');
  }
  if (typeof opts.seed !== 'string' || !opts.seed) {
    throw validationError('seed', 'seed is required');
  }

  const parsed = parseEd25519SecretKey(opts.privateKey);
  // tweetnacl's secretKey is 64-byte concat(seed || publicKey); the first
  // 32 bytes are the ed25519 seed, which is what the SKILL doc's example
  // names as "near_private_key" for the HMAC derivation.
  const seedBytes = parsed.secretKey.slice(0, 32);
  const keyIndex = opts.keyIndex ?? 0;
  const derivationInput = new TextEncoder().encode(
    `${opts.seed}:${keyIndex}`,
  );
  const derivedHmac = await hmacSha256(seedBytes, derivationInput);
  const walletKey = `wk_${bytesToHex(derivedHmac)}`;
  const keyHashBytes = await sha256(new TextEncoder().encode(walletKey));
  const keyHash = bytesToHex(keyHashBytes);

  const unixSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const message = `api-key:${opts.seed}:${unixSeconds}`;
  const signature = signRegisterMessage(message, parsed.secretKey);

  const fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.outlayerUrl}/wallet/v1/api-key`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: opts.accountId,
        seed: opts.seed,
        key_hash: keyHash,
        pubkey: encodeEd25519PublicKey(parsed.publicKey),
        message,
        signature: encodeSignatureBase58(signature),
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
      throw authError(`OutLayer rejected mint-delegate-key (${res.status})`);
    }
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `mint-delegate-key ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError(
      'mint-delegate-key: malformed JSON in 2xx response',
    );
  }
  if (!body || typeof body !== 'object') {
    throw protocolError(
      'mint-delegate-key: response body is not an object',
    );
  }
  const b = body as Record<string, unknown>;
  const walletId = b.wallet_id;
  const nearAccountId = b.near_account_id;

  if (typeof walletId !== 'string' || !walletId) {
    throw protocolError('mint-delegate-key: response missing wallet_id');
  }
  if (typeof nearAccountId !== 'string' || !nearAccountId) {
    throw protocolError(
      'mint-delegate-key: response missing near_account_id',
    );
  }

  return { walletId, nearAccountId, walletKey };
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
export async function getBalance(
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

  // Two-stage BigInt divide (yocto → pico → float) keeps 12 decimal
  // places and stays under `Number.MAX_SAFE_INTEGER` for balances up to
  // ~9M NEAR. Raw `balance` remains the source of truth.
  let balanceNear: number | undefined;
  if (chain === 'near') {
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

/**
 * Primitive signing input. General-purpose — no Nearly-convention
 * assumptions baked in.
 */
export interface SignMessageInput {
  message: string;
  recipient: string;
  format?: 'nep413' | 'raw';
}

/**
 * Primitive: ask OutLayer to sign an arbitrary message with this wallet
 * key. Thin wrapper over `POST /wallet/v1/sign-message`. Returns a
 * `VerifiableClaim` envelope (account_id, public_key, signature, nonce,
 * message) — the response shape is the same regardless of format or
 * content; callers hand it to whichever verifier they're talking to.
 *
 * Use `signClaim` in `./claim` to sign a NEP-413 structured envelope
 * in a chosen domain; use `signMessage` directly to authenticate to
 * protocols that don't speak the NEP-413 claim envelope, or to emit
 * raw ed25519 signatures via `format: 'raw'`.
 *
 * Errors:
 * - Network/timeout → `networkError`
 * - 401/403 → `authError`
 * - Other non-2xx → `protocolError`
 * - Non-JSON or missing fields → `protocolError`
 */
export async function signMessage(
  client: WalletClient,
  input: SignMessageInput,
): Promise<VerifiableClaim> {
  const wireBody: Record<string, unknown> = {
    message: input.message,
    recipient: input.recipient,
  };
  if (input.format === 'raw') wireBody.format = 'raw';

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
      body: JSON.stringify(wireBody),
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
      `signMessage ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('signMessage: malformed JSON in 2xx response');
  }
  if (!body || typeof body !== 'object') {
    throw protocolError('signMessage: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.account_id !== 'string' ||
    typeof b.public_key !== 'string' ||
    typeof b.signature !== 'string' ||
    typeof b.nonce !== 'string'
  ) {
    throw protocolError('signMessage: response missing claim fields');
  }
  return {
    account_id: b.account_id,
    public_key: b.public_key,
    signature: b.signature as string,
    nonce: b.nonce as string,
    message: input.message,
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

  // OutLayer signals WASM execution failures with `status: "failed"` at
  // the top level — check before decoding the inner response payload.
  if (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'failed'
  ) {
    throw protocolError('callOutlayer: WASM execution failed');
  }

  return decodeWasmResponse(result);
}
