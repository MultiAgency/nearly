import type { FetchLike } from '../../src/read';
import { createWalletClient, type WalletClient } from '../../src/wallet';

export interface Call {
  url: string;
  init?: RequestInit;
}

export function scripted(
  handler: (url: string, init?: RequestInit) => Response,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function walletOf(
  fetch: FetchLike,
  walletKey = 'wk_test',
): WalletClient {
  return createWalletClient({
    outlayerUrl: 'https://outlayer.example',
    namespace: 'contextual.near',
    walletKey,
    fetch,
    claimDomain: 'nearly.social',
    claimVersion: 1,
  });
}
