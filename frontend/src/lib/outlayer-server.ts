import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  LIMITS,
  OUTLAYER_ADMIN_ACCOUNT,
  OUTLAYER_ADMIN_NEAR_KEY,
  OUTLAYER_API_URL,
  OUTLAYER_PROJECT_NAME,
  OUTLAYER_PROJECT_OWNER,
} from '@/lib/constants';
import { fetchWithTimeout, httpErrorText } from '@/lib/fetch';
import { PUBLIC_ACTIONS, queryFieldsForAction } from '@/lib/routes';
import { wasmCodeToStatus } from '@/lib/utils';
import type { VerifiableClaim } from '@/types';
import { errJson } from './api-response';

const COMMON_FIELDS = ['action', 'account_id'];

const PUBLIC_ACTION_FIELDS: Record<string, readonly string[]> = {};
for (const action of PUBLIC_ACTIONS) {
  PUBLIC_ACTION_FIELDS[action] = queryFieldsForAction(action);
}

interface WasmResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  hint?: string;
  retry_after?: number;
  pagination?: {
    limit: number;
    next_cursor?: string;
    cursor_reset?: boolean;
  };
}

function isWasmShape(v: unknown): v is WasmResponse {
  if (typeof v !== 'object' || v === null || !('success' in v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.success === 'boolean' &&
    (r.error === undefined || typeof r.error === 'string') &&
    (r.code === undefined || typeof r.code === 'string')
  );
}

export function decodeOutlayerResponse<T = unknown>(
  result: unknown,
): WasmResponse<T> {
  if (typeof result === 'string') {
    if (result.length > LIMITS.MAX_RESPONSE_BYTES) {
      throw new Error('OutLayer response too large');
    }
    let decoded: string;
    try {
      decoded = atob(result);
    } catch {
      throw new Error('Invalid base64 in OutLayer response');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error('Invalid JSON in OutLayer base64 payload');
    }
    if (isWasmShape(parsed)) return parsed as WasmResponse<T>;
    throw new Error('Unexpected OutLayer response format');
  }

  if (typeof result !== 'object' || result === null) {
    throw new Error('Unexpected OutLayer response format');
  }

  const r = result as Record<string, unknown>;

  if (r.output) {
    if (
      typeof r.output === 'string' &&
      r.output.length > LIMITS.MAX_RESPONSE_BYTES
    ) {
      throw new Error('OutLayer output field too large');
    }
    let decoded: unknown;
    try {
      decoded =
        typeof r.output === 'string' ? JSON.parse(atob(r.output)) : r.output;
    } catch {
      throw new Error('Invalid base64 in OutLayer output field');
    }
    if (isWasmShape(decoded)) return decoded as WasmResponse<T>;
    throw new Error('OutLayer output is not a valid WASM response');
  }

  if (isWasmShape(r)) return r as WasmResponse<T>;

  throw new Error('Unexpected OutLayer response format');
}

export function getOutlayerPaymentKey(): string {
  const key = process.env.OUTLAYER_PAYMENT_KEY || '';
  if (process.env.NODE_ENV === 'production' && !key) {
    throw new Error(
      'OUTLAYER_PAYMENT_KEY is not set — the API cannot function without it. Set this env var and redeploy.',
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Admin near: token helpers — sign admin writes as hack.near via OutLayer's
// deterministic wallet. The server holds hack.near's NEAR ed25519 key as
// OUTLAYER_ADMIN_NEAR_KEY, builds a fresh near:<base64url> token per write
// (±30s window), and submits via writeToFastData the same way wk_ auth does.
// ---------------------------------------------------------------------------

const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(str: string): Uint8Array {
  const bytes = [0];
  for (const ch of str) {
    const val = B58_ALPHA.indexOf(ch);
    if (val < 0) throw new Error(`invalid base58 char: ${ch}`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

function b58encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = digits.length - 1; i >= 0; i--) {
    out += B58_ALPHA[digits[i]];
  }
  for (const b of bytes) {
    if (b === 0) out = `1${out}`;
    else break;
  }
  return out || '1';
}

const ADMIN_SEED = 'admin';
const DER_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

let adminKeyParsed: {
  privateKey: ReturnType<typeof createPrivateKey>;
  pubkeyB58: string;
  accountId: string;
} | null = null;

function parseAdminNearKey(): typeof adminKeyParsed {
  if (adminKeyParsed) return adminKeyParsed;
  if (!OUTLAYER_ADMIN_NEAR_KEY) return null;
  const b58 = OUTLAYER_ADMIN_NEAR_KEY.replace(/^ed25519:/, '');
  const expanded = b58decode(b58);
  if (expanded.length !== 64) return null;
  const seed32 = expanded.slice(0, 32);
  const pub32 = expanded.slice(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([DER_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubkeyB58 = `ed25519:${b58encode(pub32)}`;
  const accountId = process.env.OUTLAYER_ADMIN_ACCOUNT || '';
  adminKeyParsed = { privateKey, pubkeyB58, accountId };
  return adminKeyParsed;
}

export function buildAdminNearToken(): string | null {
  const parsed = parseAdminNearKey();
  if (!parsed) return null;
  const ts = Math.floor(Date.now() / 1000);
  const message = `auth:${ADMIN_SEED}:${ts}`;
  const sigBytes = cryptoSign(null, Buffer.from(message), parsed.privateKey);
  const signatureB58 = b58encode(new Uint8Array(sigBytes));
  const payload = JSON.stringify({
    account_id: parsed.accountId,
    seed: ADMIN_SEED,
    pubkey: parsed.pubkeyB58,
    timestamp: ts,
    signature: signatureB58,
  });
  return `near:${Buffer.from(payload).toString('base64url')}`;
}

let adminWriterAccountCached: string | null = null;

export async function resolveAdminWriterAccount(): Promise<string | null> {
  if (adminWriterAccountCached) return adminWriterAccountCached;
  const token = buildAdminNearToken();
  if (token) {
    const fromBalance = await accountIdFromBalance(token);
    if (fromBalance) {
      adminWriterAccountCached = fromBalance;
      return fromBalance;
    }
  }
  // Fallback: OUTLAYER_ADMIN_ACCOUNT is the custody wallet's account_id
  // (what /wallet/v1/balance returns for the admin wk_). Works without
  // OUTLAYER_ADMIN_NEAR_KEY — the env var is set to the same value the
  // near: token path would resolve to.
  if (OUTLAYER_ADMIN_ACCOUNT) {
    adminWriterAccountCached = OUTLAYER_ADMIN_ACCOUNT;
    return OUTLAYER_ADMIN_ACCOUNT;
  }
  return null;
}

// Claims can't be cached — NEP-413 nonces are single-use. Account IDs can —
// they're deterministic per wallet key, so accountCache holds them for the
// life of the process (cold starts clear it).

const accountCache = new Map<string, string>();
const SIGN_TIMEOUT_MS = 5_000;
const CLAIM_DOMAIN = 'nearly.social';
const CLAIM_VERSION = 1;

function buildClaimMessage(action: string, accountId: string): string {
  return JSON.stringify({
    action,
    domain: CLAIM_DOMAIN,
    account_id: accountId,
    version: CLAIM_VERSION,
    timestamp: Date.now(),
  });
}

export async function signMessage(
  walletKey: string,
  message: string,
  format?: 'nep413' | 'raw',
): Promise<Record<string, string> | null> {
  const body: Record<string, string> = { message, recipient: CLAIM_DOMAIN };
  if (format) body.format = format;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${OUTLAYER_API_URL}/wallet/v1/sign-message`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${walletKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      SIGN_TIMEOUT_MS,
    );
  } catch (err) {
    console.error('[outlayer-server] signMessage network error:', err);
    return null;
  }
  if (!resp.ok) {
    console.error(
      '[outlayer-server] signMessage http error:',
      resp.status,
      await httpErrorText(resp),
    );
    return null;
  }
  try {
    const r = (await resp.json()) as Record<string, unknown>;
    if (
      typeof r.account_id === 'string' &&
      typeof r.public_key === 'string' &&
      typeof r.signature === 'string' &&
      typeof r.nonce === 'string'
    ) {
      const result: Record<string, string> = {
        account_id: r.account_id,
        public_key: r.public_key,
        signature: r.signature,
        nonce: r.nonce,
      };
      if (typeof r.signature_base64 === 'string') {
        result.signature_base64 = r.signature_base64;
      }
      return result;
    }
    console.error('[outlayer-server] signMessage malformed response:', r);
    return null;
  } catch (err) {
    console.error('[outlayer-server] signMessage parse error:', err);
    return null;
  }
}

/**
 * Ask OutLayer's balance endpoint for the caller's `account_id`. `GET
 * /wallet/v1/balance?chain=near` returns the canonical 64-hex implicit
 * account in its 2xx body — cheaper than a sign-message round-trip and
 * spends no TEE budget. Returns null on any upstream/parse failure so
 * the caller can fall back to sign-message instead of surfacing a
 * transient outage as a hard identity failure.
 */
async function accountIdFromBalance(walletKey: string): Promise<string | null> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${OUTLAYER_API_URL}/wallet/v1/balance?chain=near`,
      { headers: { Authorization: `Bearer ${walletKey}` } },
      SIGN_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const body = (await resp.json().catch((e: unknown) => {
    console.error('[resolveAccountIdFromBalance] json parse failed', e);
    return null;
  })) as {
    account_id?: unknown;
  } | null;
  if (body && typeof body.account_id === 'string' && body.account_id) {
    return body.account_id;
  }
  return null;
}

export async function resolveAccountId(
  walletKey: string,
): Promise<string | null> {
  const cached = accountCache.get(walletKey);
  if (cached) return cached;

  // wk_ only: balance is cheaper than sign-message. near: tokens can
  // reach here via register_platforms passthrough; sign-message accepts
  // them (CLAUDE.md Auth), balance's near: support is undocumented.
  if (walletKey.startsWith('wk_')) {
    const fromBalance = await accountIdFromBalance(walletKey);
    if (fromBalance) {
      accountCache.set(walletKey, fromBalance);
      return fromBalance;
    }
  }

  const msg = JSON.stringify({ action: 'resolve', domain: CLAIM_DOMAIN });
  const result = await signMessage(walletKey, msg);
  if (!result) return null;

  accountCache.set(walletKey, result.account_id);
  return result.account_id;
}

/**
 * Produces the signed `VerifiableClaim` but does not submit it — the
 * caller forwards the claim to whoever needs to verify it.
 */
export async function signClaimForWalletKey(
  walletKey: string,
  action: string,
): Promise<VerifiableClaim | null> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return null;

  const message = buildClaimMessage(action, accountId);
  const result = await signMessage(walletKey, message);
  if (!result) return null;

  return {
    account_id: accountId,
    public_key: result.public_key,
    signature: result.signature,
    nonce: result.nonce,
    message,
  };
}

const OUTLAYER_RESOURCE_LIMITS = {
  max_instructions: 2_000_000_000,
  max_memory_mb: 512,
  max_execution_seconds: 30,
} as const;

const STRUCTURED_FIELDS = new Set(['tags', 'capabilities']);

export function sanitizePublic(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const action = body.action as string | undefined;
  const allowed = new Set([
    ...COMMON_FIELDS,
    ...((action && PUBLIC_ACTION_FIELDS[action]) || []),
  ]);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) || value == null) continue;
    if (STRUCTURED_FIELDS.has(key)) {
      clean[key] = value;
    } else {
      const t = typeof value;
      if (t === 'string' || t === 'number' || t === 'boolean') {
        clean[key] = value;
      }
    }
  }
  return clean;
}

export interface OutlayerResult {
  response: NextResponse;
  /** Decoded WASM output — null on upstream/decode errors. */
  decoded: WasmResponse | null;
}

export async function callOutlayer(
  wasmBody: Record<string, unknown>,
  authKey: string,
): Promise<OutlayerResult> {
  const url = `${OUTLAYER_API_URL}/call/${OUTLAYER_PROJECT_OWNER}/${OUTLAYER_PROJECT_NAME}`;

  const isWalletKey = authKey.startsWith('wk_');
  const authHeaders: Record<string, string> = isWalletKey
    ? { Authorization: `Bearer ${authKey}` }
    : { 'X-Payment-Key': authKey };

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          input: wasmBody,
          resource_limits: OUTLAYER_RESOURCE_LIMITS,
        }),
      },
      30_000,
    );
  } catch {
    return {
      response: errJson('INTERNAL_ERROR', 'Upstream unreachable', 502),
      decoded: null,
    };
  }

  if (!response.ok) {
    if (response.status === 402) {
      return {
        response: errJson(
          'INTERNAL_ERROR',
          'OutLayer quota exhausted — top up the payment key balance',
          503,
        ),
        decoded: null,
      };
    }
    return {
      response: errJson(
        'INTERNAL_ERROR',
        `Upstream error: ${response.status}`,
        response.status >= 400 && response.status < 500 ? response.status : 502,
      ),
      decoded: null,
    };
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return {
      response: errJson('INTERNAL_ERROR', 'Invalid JSON from OutLayer', 502),
      decoded: null,
    };
  }

  if (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<string, unknown>).status === 'failed'
  ) {
    return {
      response: errJson('INTERNAL_ERROR', 'WASM execution failed', 502),
      decoded: null,
    };
  }

  try {
    const decoded = decodeOutlayerResponse(result);
    return {
      response: NextResponse.json(decoded, {
        status: decoded.success ? 200 : wasmCodeToStatus(decoded.code),
      }),
      decoded,
    };
  } catch {
    return {
      response: errJson('INTERNAL_ERROR', 'Failed to decode WASM output', 502),
      decoded: null,
    };
  }
}
