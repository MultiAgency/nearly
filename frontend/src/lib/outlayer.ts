import { API_TIMEOUT_MS } from './constants';
import { assertOk, fetchWithTimeout } from './fetch';

export interface OutlayerRegisterResponse {
  api_key: string;
  near_account_id: string;
  handoff_url: string;
  trial: boolean;
}

export interface SignMessageRequest {
  message: string;
  recipient: string;
  format?: 'nep413' | 'raw';
}

export interface SignMessageResponse {
  account_id: string;
  public_key: string;
  signature: string;
  signature_base64?: string;
  nonce: string;
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

export async function signMessage(
  apiKey: string,
  message: string,
  recipient: string,
  format?: 'nep413' | 'raw',
): Promise<SignMessageResponse> {
  const body: SignMessageRequest = { message, recipient };
  if (format) body.format = format;
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/sign-message',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export interface DeterministicRegisterRequest {
  account_id: string;
  seed: string;
  pubkey: string;
  message: string;
  signature: string;
}

/**
 * Deterministic registration does NOT return an api_key — the caller
 * authenticates via `Bearer near:<base64url>` tokens signed with their
 * NEAR key instead. Idempotent: same (account_id, seed) always returns
 * the same wallet.
 */
export interface DeterministicRegisterResponse {
  near_account_id: string;
  trial: { calls_remaining: number; expires_at: string };
}

export async function registerOutlayerDeterministic(
  params: DeterministicRegisterRequest,
): Promise<DeterministicRegisterResponse> {
  const res = await fetchWithTimeout(
    '/api/outlayer/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

// ---------------------------------------------------------------------------
// Sub-agent key management
// ---------------------------------------------------------------------------

export async function createSubAgentKey(
  apiKey: string,
  params: { seed: string; key_hash: string },
): Promise<{ wallet_id: string; near_account_id: string }> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/api-key',
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(params),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function revokeSubAgentKey(
  apiKey: string,
  keyHash: string,
): Promise<void> {
  const res = await fetchWithTimeout(
    `/api/outlayer/wallet/v1/api-key/${keyHash}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
}

// ---------------------------------------------------------------------------
// Cross-chain deposit / withdraw
// ---------------------------------------------------------------------------

export interface DepositIntentRequest {
  chain?: string;
  amount: string;
  token?: string;
  refund_address?: string;
  destination_asset?: string;
}

export interface DepositIntentResponse {
  intent_id: string;
  deposit_address: string;
  amount: string;
  amount_out: string;
  min_amount_out: string;
  expires_at: string;
  estimated_time_secs: number;
}

export async function createDepositIntent(
  apiKey: string,
  params: DepositIntentRequest,
): Promise<DepositIntentResponse> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/deposit-intent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(params),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function getDepositStatus(
  apiKey: string,
  intentId: string,
): Promise<{ status: string; [key: string]: unknown }> {
  const res = await fetchWithTimeout(
    `/api/outlayer/wallet/v1/deposit-status?id=${encodeURIComponent(intentId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function listDeposits(
  apiKey: string,
  limit = 20,
): Promise<{ deposits: unknown[] }> {
  const res = await fetchWithTimeout(
    `/api/outlayer/wallet/v1/deposits?limit=${limit}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

// ---------------------------------------------------------------------------
// Payment checks
// ---------------------------------------------------------------------------

export interface PaymentCheckCreateRequest {
  token: string;
  amount: string;
  memo?: string;
  expires_in?: number;
}

export interface PaymentCheckCreateResponse {
  request_id: string;
  status: string;
  check_id: string;
  check_key: string;
  token: string;
  amount: string;
  memo?: string;
  created_at: string;
  expires_at?: string;
}

export async function createPaymentCheck(
  apiKey: string,
  params: PaymentCheckCreateRequest,
): Promise<PaymentCheckCreateResponse> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/payment-check/create',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(params),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function batchCreatePaymentChecks(
  apiKey: string,
  checks: PaymentCheckCreateRequest[],
): Promise<{ checks: PaymentCheckCreateResponse[] }> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/payment-check/batch-create',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ checks }),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function claimPaymentCheck(
  apiKey: string,
  checkKey: string,
  amount?: string,
): Promise<{
  request_id: string;
  status: string;
  token: string;
  amount_claimed: string;
  remaining: string;
  memo?: string;
  claimed_at: string;
  intent_hash: string;
}> {
  const body: Record<string, string> = { check_key: checkKey };
  if (amount) body.amount = amount;
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/payment-check/claim',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function reclaimPaymentCheck(
  apiKey: string,
  checkId: string,
  amount?: string,
): Promise<{
  request_id: string;
  status: string;
  token: string;
  amount_reclaimed: string;
  remaining: string;
  reclaimed_at: string;
  intent_hash: string;
}> {
  const body: Record<string, string> = { check_id: checkId };
  if (amount) body.amount = amount;
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/payment-check/reclaim',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function peekPaymentCheck(
  apiKey: string,
  checkKey: string,
): Promise<{
  token: string;
  balance: string;
  memo?: string;
  status: string;
  expires_at?: string;
}> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/payment-check/peek',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ check_key: checkKey }),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function getPaymentCheckStatus(
  apiKey: string,
  checkId: string,
): Promise<{
  check_id: string;
  token: string;
  amount: string;
  claimed_amount: string;
  reclaimed_amount: string;
  memo?: string;
  status: string;
  created_at: string;
  expires_at?: string;
  claimed_at?: string;
  claimed_by?: string;
}> {
  const res = await fetchWithTimeout(
    `/api/outlayer/wallet/v1/payment-check/status?check_id=${encodeURIComponent(checkId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function listPaymentChecks(
  apiKey: string,
  params?: { status?: string; limit?: number },
): Promise<{ checks: unknown[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs}` : '';
  const res = await fetchWithTimeout(
    `/api/outlayer/wallet/v1/payment-check/list${suffix}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

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
