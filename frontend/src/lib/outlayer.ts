import { API_TIMEOUT_MS } from './constants';
import { assertOk, fetchWithTimeout } from './fetch';

/**
 * `POST /register` on api.outlayer.fastnear.com returns the full shape below.
 * `OutlayerRegisterResponse` types the fields Nearly currently reads —
 * required fields are load-bearing, optional fields are surfaced
 * pass-through for consumers that want them (the runtime `registerOutlayer`
 * just returns `res.json()`, so every wire field is already reachable at
 * runtime; the type is the only gate on callers).
 *
 *   {
 *     wallet_id:        string     // opaque custody-wallet UUID (not yet typed)
 *     api_key:          string     // wk_-prefixed bearer token (required)
 *     near_account_id:  string     // 64-hex NEAR account (required)
 *     handoff_url:      string     // https://outlayer.fastnear.com/wallet?key=wk_...
 *                                  //   hosted wallet-management UI; deep-link
 *                                  //   for a "Manage wallet" affordance (typed)
 *     trial: {
 *       calls_remaining: number    // (required)
 *       expires_at:      string    // ISO-8601 — trial window end (typed)
 *       limits: {                  // per-call TEE execution budget (not yet typed)
 *         max_instructions:       number
 *         max_execution_seconds:  number
 *         max_memory_mb:          number
 *       }
 *     }
 *   }
 *
 * Verified against production /register on 2026-04-14.
 */
export interface OutlayerRegisterResponse {
  api_key: string;
  near_account_id: string;
  handoff_url?: string;
  trial: {
    calls_remaining: number;
    expires_at?: string;
  };
}

export async function registerOutlayer(): Promise<OutlayerRegisterResponse> {
  const res = await fetchWithTimeout(
    '/api/outlayer/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function getBalance(apiKey: string): Promise<string> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/balance?chain=near',
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    API_TIMEOUT_MS,
  );

  await assertOk(res);

  let data: { balance?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error('Balance check failed: unexpected response format');
  }
  return data.balance || '0';
}
