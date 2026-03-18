// NEAR Social (social.near) — read/write agent profiles on-chain
// Read: free RPC view calls, no auth
// Write: via OutLayer POST /wallet/v1/call, needs gas

const NEAR_RPC_URL = 'https://rpc.mainnet.near.org';
const SOCIAL_CONTRACT = 'social.near';

export interface SocialProfile {
  name?: string;
  description?: string;
  image?: { url?: string; ipfs_cid?: string };
  linktree?: Record<string, string>;
}

export interface AgentMarketData {
  handle?: string;
  registered_at?: string;
  capabilities?: string[];
}

export interface OnChainProfile {
  profile?: SocialProfile;
  agent_market?: AgentMarketData;
}

/**
 * Read a single account's profile from social.near.
 * Free RPC view call — no auth, no gas.
 */
export async function getProfile(
  accountId: string,
): Promise<OnChainProfile | null> {
  const keys = [`${accountId}/profile/**`, `${accountId}/agent_market/**`];
  const args = JSON.stringify({ keys });
  const argsBase64 = btoa(args);

  try {
    const res = await fetch(NEAR_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'near-social',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: SOCIAL_CONTRACT,
          method_name: 'get',
          args_base64: argsBase64,
        },
      }),
    });

    const json = await res.json();

    if (json.error || !json.result?.result) {
      return null;
    }

    // Decode the result bytes to JSON
    const bytes = new Uint8Array(json.result.result);
    const decoded = new TextDecoder().decode(bytes);
    const data = JSON.parse(decoded);

    // data is { "account_id": { "profile": {...}, "agent_market": {...} } }
    return data[accountId] || null;
  } catch {
    return null;
  }
}

/**
 * Read profiles for multiple accounts in a single RPC call.
 */
export async function getProfiles(
  accountIds: string[],
): Promise<Record<string, OnChainProfile>> {
  if (accountIds.length === 0) return {};

  const keys = accountIds.flatMap((id) => [
    `${id}/profile/**`,
    `${id}/agent_market/**`,
  ]);
  const args = JSON.stringify({ keys });
  const argsBase64 = btoa(args);

  try {
    const res = await fetch(NEAR_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'near-social-batch',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: SOCIAL_CONTRACT,
          method_name: 'get',
          args_base64: argsBase64,
        },
      }),
    });

    const json = await res.json();

    if (json.error || !json.result?.result) {
      return {};
    }

    const bytes = new Uint8Array(json.result.result);
    const decoded = new TextDecoder().decode(bytes);
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

/**
 * Build the args for social.near:set() to save a profile.
 * Returns the args object to pass to OutLayer's POST /wallet/v1/call.
 */
export function buildProfileSetArgs(
  accountId: string,
  profile: SocialProfile,
  agentMarket?: AgentMarketData,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    [accountId]: {
      profile,
      ...(agentMarket && { agent_market: agentMarket }),
    },
  };

  return { data };
}

/**
 * Storage deposit needed for first write to social.near.
 * ~0.05 NEAR covers typical profile data.
 */
export const SOCIAL_STORAGE_DEPOSIT = '50000000000000000000000'; // 0.05 NEAR in yoctoNEAR
