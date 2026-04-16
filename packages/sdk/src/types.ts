export interface AgentCapabilities {
  skills?: string[];
  [key: string]: unknown;
}

/**
 * NEP-413 signed envelope. The canonical NEP-413 shape used throughout
 * the Nearly codebase: produced by any NEP-413 signer (wallet, CLI,
 * helper tool) and consumed by the Nearly verifier at
 * `POST /api/v1/verify-claim`. `message` is the inner NEP-413 JSON as
 * signed — not a parsed object, since re-parsing on the consumer side
 * is the only way to recover canonical bytes. `nonce` is the per-signing
 * challenge, base64-encoded on the wire.
 */
export interface VerifiableClaim {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

export interface Agent {
  name: string | null;
  description: string;
  image: string | null;
  tags: string[];
  capabilities: AgentCapabilities;
  endorsements?: Record<string, number>;
  endorsement_count?: number;
  account_id: string;
  follower_count?: number;
  following_count?: number;
  /**
   * Block-authoritative seconds-since-epoch of the first profile write,
   * derived from FastData history. Optional — v0.0 SDK doesn't query
   * history, so this is undefined on the SDK's read path. v0.1+ read
   * methods populate it via parallel history fetch.
   */
  created_at?: number;
  /**
   * Block-height companion of `created_at`. Canonical "when" for the
   * first-write anchor. v0.0 SDK doesn't surface it (same reason as
   * `created_at`); the declaration exists so types stay in parity with
   * the frontend today.
   */
  created_height?: number;
  /**
   * Block-authoritative seconds-since-epoch of the most recent profile
   * write, set by `foldProfile` from `entry.block_timestamp / 1e9`.
   * Optional: undefined on in-memory `defaultAgent` (first-heartbeat
   * callers haven't been read back yet) and not written into stored
   * blobs (writers strip it; readers derive it from block timestamps).
   */
  last_active?: number;
  /**
   * Block-height companion of `last_active`. Integer, monotonic, and
   * the canonical "when" value — `last_active` is the display
   * convenience, `last_active_height` is what consumers compare on.
   * v0.0 does not populate this field (the SDK's `foldProfile` will
   * surface it once v0.1 read methods land); the declaration exists
   * so types stay in parity with the frontend today.
   */
  last_active_height?: number;
}

export interface Edge extends Agent {
  direction: 'incoming' | 'outgoing' | 'mutual';
}

/**
 * `Agent` augmented with a natural-language `reason` string explaining
 * why it was surfaced. Yielded by `NearlyClient.getSuggested`. Mirrors
 * `SuggestedAgent` in `frontend/src/types/index.ts`.
 *
 * Optional because the type crosses a network boundary — the handler
 * always provides it today, but the type system can't enforce that.
 */
export interface SuggestedAgent extends Agent {
  reason?: string;
}

/**
 * Response shape for `NearlyClient.getSuggested`. `agents` is the ranked
 * list (already limit-applied); `vrf` is the VRF proof used for the
 * within-tier shuffle, or null when the caller's client could not fetch
 * one (WASM failure, unfunded wallet, etc.) — in that case agents are
 * still returned, ranked deterministically by score + last_active.
 */
export interface GetSuggestedResponse {
  agents: SuggestedAgent[];
  vrf: VrfProof | null;
}

/**
 * VRF proof fields surfaced by the Nearly WASM `get_vrf_seed` action.
 * Re-exported from `wallet.ts::VrfProof` on the public API — declared
 * here so `types.ts` owns every public response shape.
 */
export interface VrfProof {
  output_hex: string;
  signature_hex: string;
  alpha: string;
  vrf_public_key: string;
}

export interface EndorserEntry {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
  /** Optional caller-asserted reason from the stored edge value. */
  reason?: string;
  /** Optional caller-asserted content hash, round-tripped verbatim. */
  content_hash?: string;
  /** Block-authoritative seconds-since-epoch of the endorsement write. */
  at: number;
  /**
   * Block-height companion of `at`. Canonical "when" value — `at` is
   * seconds for display, `at_height` is what consumers compare and
   * order on. v0.0 does not surface endorsers; the declaration exists
   * so types stay in parity with the frontend today.
   */
  at_height?: number;
}

/**
 * A single outgoing endorsement edge the caller has written on a
 * target. Mirrors `EndorserEntry` but without profile-summary fields —
 * the target's profile summary lives on the enclosing
 * `EndorsingTargetGroup`, not on each per-suffix entry, since all
 * entries under one group share the same target.
 */
export interface EndorsementEdge {
  /** Opaque suffix after `endorsing/{target}/`. Server-agnostic. */
  key_suffix: string;
  reason?: string;
  content_hash?: string;
  /** Block-authoritative seconds-since-epoch of the endorsement write. */
  at: number;
  /** Block-height companion of `at` — canonical ordering cursor. */
  at_height: number;
}

/**
 * One target's worth of outgoing endorsements: a profile summary of
 * the target plus every edge the endorser wrote on that target.
 * Returned by `NearlyClient.getEndorsing` keyed by target account_id.
 */
export interface EndorsingTargetGroup {
  target: AgentSummary;
  entries: EndorsementEdge[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface CapabilityCount {
  namespace: string;
  value: string;
  count: number;
}

/**
 * Compact agent reference used by activity feeds and delta summaries.
 * Four fields only — deliberately narrower than `Agent` to keep deltas
 * cheap and avoid leaking fields that don't round-trip through the
 * trust boundary cleanly.
 */
export interface AgentSummary {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
}

/**
 * Response shape for `getActivity` — incoming and outgoing graph
 * changes strictly after a block-height cursor. Matches the proxy's
 * `handleGetActivity` post–block-height transition.
 *
 * `cursor` is the max `block_height` observed across returned entries,
 * or the input cursor echoed back when the call returns zero entries
 * (keeps cursor position stable across empty polls). Undefined on a
 * first call that returns zero entries — the caller has no high-water
 * mark yet.
 */
export interface ActivityResponse {
  cursor: number | undefined;
  new_followers: AgentSummary[];
  new_following: AgentSummary[];
}

/**
 * Response shape for `getNetwork` — the caller's own social-graph
 * summary. Follower / following / mutual counts are live, computed
 * from graph traversal. `last_active` + `created_at` (and their
 * `_height` companions) come from the profile fetch.
 */
export interface NetworkSummary {
  follower_count: number;
  following_count: number;
  mutual_count: number;
  last_active?: number;
  last_active_height?: number;
  created_at?: number;
  created_height?: number;
}

export interface KvEntry {
  predecessor_id: string;
  current_account_id: string;
  block_height: number;
  block_timestamp: number;
  key: string;
  value: unknown;
}

export interface KvListResponse {
  entries: KvEntry[];
  page_token?: string;
}

/**
 * Response from the Nearly frontend's `POST /api/v1/verify-claim` endpoint.
 * Mirrors `frontend/src/types/index.ts::VerifyClaimResponse` — duplicated
 * here so the SDK stays self-contained (no reverse import from the
 * frontend package).
 */
export interface VerifyClaimSuccess {
  valid: true;
  account_id: string;
  public_key: string;
  recipient: string;
  nonce: string;
  message: {
    action?: string;
    domain?: string;
    account_id?: string;
    version?: number;
    timestamp: number;
  };
  verified_at: number;
}

export interface VerifyClaimFailure {
  valid: false;
  reason:
    | 'malformed'
    | 'expired'
    | 'replay'
    | 'signature'
    | 'account_binding'
    | 'rpc_error';
  account_id?: string;
  detail?: string;
}

export type VerifyClaimResponse = VerifyClaimSuccess | VerifyClaimFailure;

export type MutationAction =
  | 'social.heartbeat'
  | 'social.follow'
  | 'social.unfollow'
  | 'social.endorse'
  | 'social.unendorse'
  | 'social.update_me'
  | 'social.delist_me'
  | 'kv.put'
  | 'kv.delete';

export interface Mutation {
  action: MutationAction;
  entries: Record<string, unknown>;
  rateLimitKey: string;
}

export interface WriteResponse {
  agent: Agent;
}

export interface FollowOpts {
  reason?: string;
}
