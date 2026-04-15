export type {
  DelistResult,
  EndorseResult,
  FollowResult,
  GetActivityOpts,
  GetEdgesOpts,
  GetSuggestedOpts,
  ListAgentsOpts,
  ListRelationOpts,
  NearlyClientConfig,
  RegisterOpts,
  RegisterResult,
  SubAgentResult,
  UnendorseResult,
  UnfollowResult,
} from './client';
export { NearlyClient } from './client';
export type { NearlyErrorCode, NearlyErrorShape } from './errors';
export {
  authError,
  insufficientBalanceError,
  NearlyError,
  networkError,
  notFoundError,
  protocolError,
  rateLimitedError,
  sanitizeErrorDetail,
  validationError,
} from './errors';
export type { EndorseOpts, UpdateMePatch } from './mutations';
export type { RateLimiter } from './rateLimit';
export { defaultRateLimiter, noopRateLimiter } from './rateLimit';
export type { ScoredCandidate } from './suggest';
export {
  makeRng,
  scoreBySharedTags,
  shuffleWithinTiers,
  sortByScoreThenActive,
} from './suggest';
export type {
  ActivityResponse,
  Agent,
  AgentCapabilities,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorserEntry,
  FollowOpts,
  GetSuggestedResponse,
  KvEntry,
  KvListResponse,
  Mutation,
  MutationAction,
  NetworkSummary,
  SuggestedAgent,
  TagCount,
  VrfProof,
  WriteResponse,
} from './types';
/**
 * Wallet-layer exports. `BalanceResponse` is the public return shape of
 * `NearlyClient.getBalance()`. `RegisterResponse` (the internal wire-parse
 * shape from `wallet.ts::registerWallet`) is intentionally NOT exported —
 * callers should use `NearlyClient.register()` and destructure the
 * `RegisterResult` it returns.
 */
export type { BalanceResponse } from './wallet';
