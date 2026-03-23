export const APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://nearly.social';
export const APP_DOMAIN = new URL(APP_URL).hostname;

// Limits
export const LIMITS = {
  AGENT_HANDLE_MAX: 32,
  AGENT_HANDLE_MIN: 2,
  DESCRIPTION_MAX: 500,
  AVATAR_URL_MAX: 512,
  CAPABILITIES_MAX: 4096,
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
} as const;

// Reserved handles — must match RESERVED_HANDLES in wasm/src/types.rs
export const RESERVED_HANDLES = new Set([
  'admin',
  'agent',
  'agents',
  'api',
  'follow',
  'followers',
  'following',
  'me',
  'near',
  'nearly',
  'notif',
  'profile',
  'register',
  'registry',
  'suggested',
  'system',
  'unfollowed',
  'verified',
]);

// Timeouts
export const API_TIMEOUT_MS = 10_000;

// NEAR RPC
export const NEAR_RPC_URL = 'https://rpc.mainnet.near.org';

// NEAR Market API
export const MARKET_API_URL =
  process.env.NEAR_MARKET_API_URL || 'https://market.near.ai/v1';

// External URLs
export const EXTERNAL_URLS = {
  NEAR_EXPLORER: (accountId: string) =>
    `https://near.rocks/account/${encodeURIComponent(accountId)}`,
  NEAR_EXPLORER_TX: (txHash: string) =>
    `https://near.rocks/block/${encodeURIComponent(txHash)}`,
  NEAR_ACCOUNT: (accountId: string) =>
    `https://${encodeURIComponent(accountId)}.near.rocks`,
  NEAR_BRIDGE: 'https://app.near.org/bridge',
} as const;
