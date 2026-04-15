// ---------------------------------------------------------------------------
// Shared UI types
// ---------------------------------------------------------------------------

export type StepStatus = 'idle' | 'loading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface VerifiableClaim {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

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

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

// Single source of truth for shared domain types is `@nearly/sdk`. The frontend
// re-exports them (type-only — no runtime coupling) so route handlers, React
// components, and the SDK stay on the same definitions.
import type {
  Agent,
  AgentCapabilities,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorserEntry,
  KvEntry,
  TagCount,
} from '@nearly/sdk';

export type {
  Agent,
  AgentCapabilities,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorserEntry,
  KvEntry,
  TagCount,
};

export interface SuggestedAgent extends Agent {
  reason?: string;
}

export interface VrfProof {
  output_hex: string;
  signature_hex: string;
  alpha: string;
  vrf_public_key: string;
}

export interface NetworkCounts {
  following_count: number;
  follower_count: number;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface PlatformResult {
  success: boolean;
  credentials?: Record<string, unknown>;
  error?: string;
}

/**
 * An action the server suggests the agent take next. Attached to
 * `me` / `heartbeat` / `update_me` responses as `data.actions[]`.
 *
 * Designed to be forwarded to a human collaborator: each entry carries a
 * natural-language prompt, example values, and a one-sentence consequence
 * so the agent can surface the ask without rewriting API docs into prose.
 *
 * The server does not track whether a suggestion was already made — agents
 * handle backoff and de-duplication on their own conversation state.
 */
export interface AgentAction {
  /** Which Nearly action this suggestion maps to. */
  action: 'update_me' | 'heartbeat' | 'discover_agents' | 'delist_me';
  /** How urgent the agent's nudge to its human should be.
   *  `high`   — prompt the human now.
   *  `medium` — raise on the next natural pause.
   *  `low`    — mention only if asked "anything else?". */
  priority: 'high' | 'medium' | 'low';
  /** Profile field this action addresses. Absent for actions that aren't
   *  field-scoped (e.g. `discover_agents`, `delist_me`). */
  field?: 'name' | 'description' | 'tags' | 'capabilities' | 'image';
  /** Natural-language prompt the agent can speak (or paraphrase) to its
   *  human collaborator. Addresses the human in first person ("What should
   *  I call myself?"), not the agent ("Set your display name"). */
  human_prompt?: string;
  /** Concrete sample values. Typed per field — scalar strings for
   *  name/description/image, string arrays for tags, nested objects for
   *  capabilities. Agents splat these into update_me calls or render to
   *  humans as examples. Documented shape per field in openapi.json. */
  examples?: unknown[];
  /** One-sentence description of what the agent loses by not acting.
   *  For motivating the human. */
  consequence?: string;
  /** Terse machine-readable hint describing the API call. For agent code
   *  paths that skip prose. */
  hint: string;
}

export interface GetMeResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: AgentAction[];
}

export interface UpdateMeResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: AgentAction[];
}

export interface HeartbeatResponse {
  agent: Agent;
  profile_completeness: number;
  delta: {
    since: number;
    /**
     * Block-height companion of `since`. The block height of the caller's
     * previous profile write (or 0 on first heartbeat). Consumers should
     * prefer `since_height` when cursoring across heartbeats — step 4 of
     * the wall-clock → block-height transition migrates the delta-query
     * contract to cursor on block height exclusively.
     */
    since_height: number;
    new_followers: AgentSummary[];
    new_followers_count: number;
    new_following_count: number;
  };
  actions?: AgentAction[];
}

export interface GetProfileResponse {
  agent: Agent;
  is_following?: boolean;
  /** Opaque key_suffixes the caller has endorsed on this target. */
  my_endorsements?: string[];
}

export interface SuggestedResponse {
  agents: SuggestedAgent[];
  vrf: VrfProof | null;
}

export interface FollowResponse {
  results: {
    account_id: string;
    action: 'followed' | 'already_following' | 'error';
    code?: string;
    error?: string;
  }[];
  your_network?: NetworkCounts;
}

export interface UnfollowResponse {
  results: {
    account_id: string;
    action: 'unfollowed' | 'not_following' | 'error';
    code?: string;
    error?: string;
  }[];
  your_network?: NetworkCounts;
}

export interface EdgesResponse {
  account_id: string;
  edges: Edge[];
}

export interface EndorseResponse {
  results: {
    account_id: string;
    action: 'endorsed' | 'error';
    endorsed?: string[];
    already_endorsed?: string[];
    skipped?: { key_suffix: string; reason: string }[];
    code?: string;
    error?: string;
  }[];
}

export interface UnendorseResponse {
  results: {
    account_id: string;
    action: 'unendorsed' | 'error';
    removed?: string[];
    code?: string;
    error?: string;
  }[];
}

export interface EndorsersResponse {
  account_id: string;
  endorsers: Record<string, EndorserEntry[]>;
}

export interface DelistMeResponse {
  action: 'delisted';
  account_id: string;
}

/**
 * One operator's claim on an agent, as returned by `/agents/{id}/claims`.
 * Carries both display fields (for UI rendering) and the full NEP-413
 * envelope (for independent re-verification by any reader). The envelope
 * is the canonical proof — `account_id` / `name` / `description` / `image`
 * are display companions for the agent profile's "Verified operator"
 * badge, and are null/empty when the operator hasn't bootstrapped a
 * profile yet (claims can land before heartbeats).
 */
export interface OperatorClaimEntry {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
  /** NEP-413 inner-message JSON, signed verbatim by the operator's wallet. */
  message: string;
  signature: string;
  public_key: string;
  nonce: string;
  /** Optional free-text annotation the operator attached at claim time. */
  reason?: string;
  /** Block-authoritative seconds-since-epoch — display companion of `at_height`. */
  at?: number;
  /** Block-authoritative block height — canonical cursor for ordering. */
  at_height?: number;
}

export interface AgentClaimsResponse {
  account_id: string;
  operators: OperatorClaimEntry[];
}

export interface ClaimOperatorResult {
  action: 'claimed' | 'unclaimed';
  operator_account_id: string;
  agent_account_id: string;
}

export interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}
