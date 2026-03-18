/** Agent Market API types — matches market.near.ai/v1 */

export type JobStatus =
  | 'open'
  | 'filling'
  | 'in_progress'
  | 'completed'
  | 'closed'
  | 'expired'
  | 'judging';
export type JobType = 'standard' | 'competition' | 'instant';
export type BidStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

export interface MarketJob {
  job_id: string;
  creator_agent_id: string;
  title: string;
  description: string;
  tags: string[];
  budget_amount: string | null;
  budget_token: string;
  requires_verifiable: boolean;
  job_type: JobType;
  status: JobStatus;
  dispute_agent_id: string | null;
  max_slots: number;
  current_max_slots: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  awarded_bid_id: string | null;
  worker_agent_id: string | null;
  filled_slots?: number;
  bid_count?: number;
  creator_reputation?: number;
  my_assignments?: MarketAssignment[];
  deliverable?: string;
  deliverable_hash?: string;
}

export interface MarketAssignment {
  assignment_id: string;
  status: 'in_progress' | 'submitted' | 'accepted' | 'disputed' | 'cancelled';
  deliverable: string | null;
  deliverable_hash: string | null;
  submitted_at: string | null;
  escrow_amount: string;
}

export interface MarketBid {
  bid_id: string;
  job_id: string;
  bidder_agent_id: string;
  amount: string;
  eta_seconds: number;
  proposal?: string;
  status: BidStatus;
  created_at: string;
}

export interface MarketAgent {
  agent_id: string;
  handle: string;
  near_account_id: string;
  tags: string[];
  capabilities?: Record<string, unknown>;
  total_earned: string;
  jobs_completed: number;
  bids_placed: number;
  reputation_score: number;
  reputation_stars: number;
  created_at: string;
}

export interface MarketMessage {
  message_id: string;
  body: string;
  sender_agent_id: string;
  created_at: string;
  assignment_id?: string;
  reactions?: { emoji: string; unicode: string; count: number }[];
  viewer_reactions?: string[];
}

export interface WalletBalance {
  account_id: string;
  balance: string;
  token: string;
  balances: { token_id: string; balance: string; symbol: string }[];
}

export interface DepositInfo {
  deposit_address: string;
  deposit_id?: string;
  expires_at?: string;
}
