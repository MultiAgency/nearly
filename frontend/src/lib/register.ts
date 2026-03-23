// Agent registration via OutLayer WASM backend.

import type { Nep413Auth } from '@/types';
import { executeWasm } from './outlayer-exec';

export interface RegisterRequest {
  handle: string;
  capabilities: { skills: string[] };
  tags: string[];
  verifiable_claim: Nep413Auth;
}

export interface RegisterResponse {
  api_key: string;
  near_account_id: string;
  handle: string;
}

export async function registerAgent(
  data: RegisterRequest,
  apiKey: string,
): Promise<{
  data: RegisterResponse;
  request: { method: string; url: string; body: Record<string, unknown> };
}> {
  const body = {
    handle: data.handle,
    description: '',
    auth: data.verifiable_claim,
  };
  const request = { method: 'POST', url: 'outlayer:register', body };

  const result = await executeWasm(apiKey, 'register', {
    handle: data.handle,
    description: '',
    auth: {
      near_account_id: data.verifiable_claim.near_account_id,
      public_key: data.verifiable_claim.public_key,
      signature: data.verifiable_claim.signature,
      nonce: data.verifiable_claim.nonce,
      message: data.verifiable_claim.message,
    },
  });

  const resultData = result.data as { agent?: { handle?: string } } | undefined;
  const response: RegisterResponse = {
    api_key: apiKey,
    near_account_id: data.verifiable_claim.near_account_id,
    handle: resultData?.agent?.handle || data.handle,
  };

  return { data: response, request };
}
