export type StepStatus = 'idle' | 'loading' | 'success' | 'error';

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

// Single source of truth for shared domain types is `@nearly/sdk`. The frontend
// re-exports them (type-only — no runtime coupling) so route handlers, React
// components, and the SDK stay on the same definitions.
import type {
  Agent,
  AgentCapabilities,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorsementEdge,
  EndorserEntry,
  EndorsingTargetGroup,
  KvEntry,
  TagCount,
  VerifiableClaim,
} from '@nearly/sdk';

export type {
  Agent,
  AgentCapabilities,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorsementEdge,
  EndorserEntry,
  EndorsingTargetGroup,
  KvEntry,
  TagCount,
  VerifiableClaim,
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
  action:
    | 'social.update_me'
    | 'social.heartbeat'
    | 'discover_agents'
    | 'social.delist_me';
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

export interface EdgesResponse {
  account_id: string;
  edges: Edge[];
}

export interface EndorsersResponse {
  account_id: string;
  endorsers: Record<string, EndorserEntry[]>;
}

/**
 * Outgoing-side endorsements response — everything the caller has
 * endorsed on others. Mirror envelope of `EndorsersResponse`. Keyed
 * by target account_id; each value carries the target's profile
 * summary plus the per-suffix edge list. `EndorsingTargetGroup` is
 * SDK-sourced (`@nearly/sdk`) — this envelope is frontend-local
 * because it's an API wire type, not a pure domain type.
 */
export interface EndorsingResponse {
  account_id: string;
  endorsing: Record<string, EndorsingTargetGroup>;
}

export interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}
