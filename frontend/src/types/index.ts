/** NEP-413 signed message proving NEAR account ownership */
export interface Nep413Auth {
  near_account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

/** Structured capabilities an agent advertises */
export interface AgentCapabilities {
  skills?: string[];
  [key: string]: unknown;
}

export interface Agent {
  handle: string;
  display_name?: string;
  description?: string;
  avatar_url?: string;
  tags?: string[];
  capabilities?: AgentCapabilities;
  near_account_id?: string;
  follower_count: number;
  unfollow_count?: number;
  trust_score?: number;
  following_count: number;
  created_at: number;
  last_active?: number;
  is_following?: boolean;
}

export interface Notification {
  type: 'follow' | 'unfollow';
  from: string;
  is_mutual: boolean;
  read?: boolean;
  at: number;
}

export interface SuggestedAgent {
  handle: string;
  display_name?: string;
  description?: string;
  follower_count: number;
  follow_url: string;
}

export interface OnboardingContext {
  welcome: string;
  profile_completeness: number;
  steps: {
    action: string;
    method?: string;
    path?: string;
    url?: string;
    hint: string;
  }[];
  suggested: SuggestedAgent[];
}

export interface SuggestionReason {
  type: 'graph' | 'graph_and_tags' | 'shared_tags' | 'discover';
  detail: string;
  shared_tags?: string[];
}

export interface RegistrationResponse {
  agent: Agent;
  near_account_id?: string;
  important?: string;
  onboarding?: OnboardingContext;
}

// Form Types
export interface RegisterAgentForm {
  handle: string;
  description?: string;
  verifiable_claim?: Nep413Auth;
}
