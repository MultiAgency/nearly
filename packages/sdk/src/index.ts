export { verifyClaim } from './claim';
export type {
  BatchEndorseItem,
  BatchFollowItem,
  BatchItemError,
  BatchUnendorseItem,
  BatchUnfollowItem,
  DelistResult,
  EndorseResult,
  EndorseTarget,
  FollowResult,
  GetActivityOpts,
  GetEdgesOpts,
  GetSuggestedOpts,
  ListAgentsOpts,
  ListRelationOpts,
  NearlyClientConfig,
  RegisterOpts,
  RegisterResult,
  SkippedKeySuffix,
  UnendorseResult,
  UnendorseTarget,
  UnfollowResult,
} from './client';
export { NearlyClient } from './client';
export { LIMITS } from './constants';
export type { NearlyErrorCode, NearlyErrorShape } from './errors';
export {
  authError,
  insufficientBalanceError,
  NearlyError,
  networkError,
  notFoundError,
  protocolError,
  rateLimitedError,
  validationError,
} from './errors';
export type {
  EndorsementGraphNode,
  EndorsementGraphReader,
  WalkOpts,
} from './graph';
export {
  buildEndorsementCounts,
  defaultAgent,
  extractCapabilityPairs,
  foldProfile,
  foldProfileList,
  profileCompleteness,
  profileGaps,
  walkEndorsementGraph,
} from './graph';
export { buildKvDelete, buildKvPut } from './kv';
export type { RateLimiter } from './rateLimit';
export { defaultRateLimiter, noopRateLimiter } from './rateLimit';
export type { EndorseOpts, UpdateMePatch } from './social';
export {
  buildDelistMe,
  buildEndorse,
  buildFollow,
  buildHeartbeat,
  buildUnendorse,
  buildUnfollow,
  buildUpdateMe,
} from './social';
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
  EndorsementEdge,
  EndorsementGraphSnapshot,
  EndorserEntry,
  EndorsingTargetGroup,
  FollowOpts,
  GetSuggestedResponse,
  KvEntry,
  KvListResponse,
  Mutation,
  MutationAction,
  NetworkSummary,
  SuggestedAgent,
  TagCount,
  VerifiableClaim,
  VerifyClaimFailure,
  VerifyClaimResponse,
  VerifyClaimSuccess,
  VrfProof,
  WriteResponse,
} from './types';
export type { BalanceResponse } from './wallet';
