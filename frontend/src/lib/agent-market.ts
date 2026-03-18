/** Agent Market API client — proxied through /api/agent-market/ → market.near.ai/v1/ */

import type {
  DepositInfo,
  MarketAgent,
  MarketBid,
  MarketJob,
  MarketMessage,
  WalletBalance,
} from '@/types/market';

const BASE = '/api/agent-market';

async function request<T>(
  path: string,
  options?: RequestInit & { apiKey?: string },
): Promise<T> {
  const { apiKey, ...init } = options || {};
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || body.message || `API error: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- Jobs ---

export async function getJob(jobId: string): Promise<MarketJob> {
  return request(`/jobs/${jobId}`);
}

export async function getJobBids(
  jobId: string,
  apiKey?: string,
): Promise<MarketBid[]> {
  const json = await request<MarketBid[] | { data: MarketBid[] }>(
    `/jobs/${jobId}/bids`,
    { apiKey },
  );
  return Array.isArray(json)
    ? json
    : (json as { data: MarketBid[] }).data || [];
}

export async function placeBid(
  jobId: string,
  data: { amount: string; eta_seconds: number; proposal: string },
  apiKey: string,
): Promise<MarketBid> {
  return request(`/jobs/${jobId}/bids`, {
    method: 'POST',
    body: JSON.stringify(data),
    apiKey,
  });
}

export async function createJob(
  data: {
    title: string;
    description: string;
    tags?: string[];
    budget_amount?: string;
    budget_token?: string;
    deadline_seconds?: number;
    job_type?: string;
  },
  apiKey: string,
): Promise<MarketJob> {
  return request('/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
    apiKey,
  });
}

export async function awardJob(
  jobId: string,
  bidId: string,
  apiKey: string,
): Promise<unknown> {
  return request(`/jobs/${jobId}/award`, {
    method: 'POST',
    body: JSON.stringify({ bid_id: bidId }),
    apiKey,
  });
}

export async function submitDeliverable(
  jobId: string,
  data: { deliverable: string; deliverable_hash?: string },
  apiKey: string,
): Promise<unknown> {
  return request(`/jobs/${jobId}/submit`, {
    method: 'POST',
    body: JSON.stringify(data),
    apiKey,
  });
}

export async function acceptDelivery(
  jobId: string,
  apiKey: string,
): Promise<unknown> {
  return request(`/jobs/${jobId}/accept`, { method: 'POST', apiKey });
}

export async function requestChanges(
  jobId: string,
  message: string,
  apiKey: string,
): Promise<unknown> {
  return request(`/jobs/${jobId}/request-changes`, {
    method: 'POST',
    body: JSON.stringify({ message }),
    apiKey,
  });
}

export async function cancelJob(
  jobId: string,
  apiKey: string,
): Promise<unknown> {
  return request(`/jobs/${jobId}/cancel`, { method: 'POST', apiKey });
}

export async function openDispute(
  jobId: string,
  data: { reason: string; evidence_urls?: string[] },
  apiKey: string,
): Promise<unknown> {
  return request(`/jobs/${jobId}/dispute`, {
    method: 'POST',
    body: JSON.stringify(data),
    apiKey,
  });
}

// --- Messages ---

export async function getJobMessages(
  jobId: string,
  apiKey?: string,
): Promise<MarketMessage[]> {
  const json = await request<MarketMessage[] | { data: MarketMessage[] }>(
    `/jobs/${jobId}/messages`,
    { apiKey },
  );
  return Array.isArray(json) ? json : [];
}

export async function sendJobMessage(
  jobId: string,
  body: string,
  apiKey: string,
): Promise<MarketMessage> {
  return request(`/jobs/${jobId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
    apiKey,
  });
}

// --- Agents ---

export async function getAgent(handleOrId: string): Promise<MarketAgent> {
  return request(`/agents/${handleOrId}`);
}

// --- Wallet ---

export async function getWalletBalance(apiKey: string): Promise<WalletBalance> {
  return request('/wallet/balance', { apiKey });
}

export async function getDepositAddress(apiKey: string): Promise<DepositInfo> {
  return request('/wallet/deposit_address', { apiKey });
}

export async function crossChainDeposit(
  data: { chain: string; asset: string },
  apiKey: string,
): Promise<DepositInfo> {
  return request('/wallet/deposit', {
    method: 'POST',
    body: JSON.stringify(data),
    apiKey,
  });
}

export async function withdraw(
  data: {
    to_account_id: string;
    amount: string;
    token_id: string;
    idempotency_key: string;
  },
  apiKey: string,
): Promise<unknown> {
  return request('/wallet/withdraw', {
    method: 'POST',
    body: JSON.stringify(data),
    apiKey,
  });
}
