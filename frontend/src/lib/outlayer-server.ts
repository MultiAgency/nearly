import { NextResponse } from 'next/server';
import {
  LIMITS,
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

/**
 * Server-held custody wallet key used to write NEP-413-verified operator
 * claims on behalf of signed-in humans. Scope expansion of the
 * `OUTLAYER_PAYMENT_KEY` pattern (see CLAUDE.md Architecture bullet on
 * "server-held operational secrets") — another named operational secret
 * Nearly's server uses to initiate its own writes. Critically, this is
 * NOT a user credential: Nearly never holds a human's NEAR private key,
 * never signs anything the human didn't NEP-413-authorize, and never
 * derives access from user secrets. The operator-claims writer key only
 * signs `operator/{operator_account_id}/{agent_account_id}` writes after
 * the handler has already verified the human's NEP-413 claim envelope.
 *
 * Returns an empty string when unset — unlike `getOutlayerPaymentKey`,
 * this helper does NOT throw in production. The operator-claim write
 * handler maps the empty return to a 503 `NOT_CONFIGURED` response so
 * deployments that don't run the Lightweight sign-in feature can leave
 * the key unset and the rest of the API stays green. Deployments that
 * DO want the feature enforce the secret's presence at deploy time
 * (startup health check, config audit, whatever) — not at request time.
 */
export function getOperatorClaimsWriterKey(): string {
  return process.env.OUTLAYER_OPERATOR_CLAIMS_WK || '';
}

/**
 * Resolve the NEAR account_id of the operator-claims writer account from its
 * `wk_` key, memoized. Used by `handleAgentClaims` to pick the predecessor
 * namespace it scans for operator-claim entries. Returns an empty string
 * when the writer key is unset — the caller interprets "no writer key
 * configured" as "no claims can exist yet" and returns an empty list,
 * keeping the read path live on deployments that haven't enabled the
 * lightweight sign-in feature.
 *
 * The lookup goes through `resolveAccountId` (OutLayer sign-message), which
 * is cached per-key for the life of the process. One sign-message at boot
 * is the cost; every subsequent call is a Map lookup.
 */
export async function getOperatorClaimsWriterAccount(): Promise<string> {
  const key = getOperatorClaimsWriterKey();
  if (!key) return '';
  const accountId = await resolveAccountId(key);
  return accountId ?? '';
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
  const body = (await resp.json().catch(() => null)) as {
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

  // For `wk_` custody wallet keys, prefer the cheap GET
  // /wallet/v1/balance?chain=near — it returns account_id in its 2xx
  // body, so a full NEP-413 sign round-trip is unnecessary for identity
  // discovery. Falls back to sign-message if the balance path fails, so
  // a transient outage on one endpoint doesn't block identity resolution.
  //
  // The wk_ gate exists because `near:` tokens can legitimately reach
  // this function via the `register_platforms` passthrough path in
  // route.ts (`near:` is only rejected for DIRECT_WRITE_ACTIONS, not
  // PASSTHROUGH_WRITE_ACTIONS). `signMessage` is known to accept
  // `near:` tokens (confirmed 2026-04-04, see CLAUDE.md "Auth" bullet);
  // whether `/wallet/v1/balance` accepts them is not documented, so we
  // route `near:` callers straight to the known-good path without
  // paying an extra failed HTTP round-trip.
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
 * Ask OutLayer to NEP-413 sign a canonical claim message for this wallet
 * key. Returns the signed `VerifiableClaim` packaged with account_id,
 * public_key, signature, nonce, and the exact signed message. The caller
 * is responsible for forwarding the claim — this function only produces
 * the signature, it does not submit anything.
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
