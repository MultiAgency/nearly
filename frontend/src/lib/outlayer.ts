import { API_TIMEOUT_MS } from './constants';
import { assertOk, fetchWithTimeout } from './fetch';

/**
 * Partial type for `POST /register`. `registerOutlayer` passes the JSON
 * through unchanged, so fields not listed here (wallet_id, trial.limits)
 * are still reachable at runtime via a cast. Full wire shape lives at
 * skills.outlayer.ai/agent-custody.
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

/**
 * OutLayer returns 502 + an HTML body (not a structured 402) when a valid
 * `wk_` points at a wallet without enough NEAR to serve the call.
 * Mirrors OutLayer's own `insufficient_balance` error code. Distinguish
 * this from auth failure so callers can surface a fund link instead of a
 * generic error.
 */
export class InsufficientBalanceError extends Error {
  constructor() {
    super('Wallet is registered but has insufficient balance.');
    this.name = 'InsufficientBalanceError';
  }
}

async function rejectIfUnfunded(res: Response): Promise<void> {
  if (res.status !== 502) return;
  const text = await res.text().catch(() => '');
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('html') || text.trimStart().startsWith('<')) {
    throw new InsufficientBalanceError();
  }
  throw new Error(text || 'HTTP 502');
}

async function fetchBalanceResponse(apiKey: string): Promise<Response> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/balance?chain=near',
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    API_TIMEOUT_MS,
  );
  await rejectIfUnfunded(res);
  await assertOk(res);
  return res;
}

export async function getBalance(apiKey: string): Promise<string> {
  const res = await fetchBalanceResponse(apiKey);
  let data: { balance?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error('Balance check failed: unexpected response format');
  }
  return data.balance || '0';
}

/** Verify a `wk_` key and resolve its NEAR account_id + balance. */
export async function verifyWallet(
  apiKey: string,
): Promise<{ account_id: string; balance: string }> {
  const res = await fetchBalanceResponse(apiKey);
  let data: { account_id?: string; balance?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error('Wallet verification failed: unexpected response format');
  }
  if (!data.account_id) {
    throw new Error('Wallet verification failed: no account_id returned');
  }
  return { account_id: data.account_id, balance: data.balance || '0' };
}
