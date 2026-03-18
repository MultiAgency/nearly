'use client';

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  Clock,
  Gavel,
  Loader2,
  RefreshCcw,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { GlowCard } from '@/components/market';
import { ApiKeyGate } from '@/components/market/ApiKeyGate';
import {
  acceptDelivery,
  getAgent,
  getJob,
  getJobBids,
  getJobMessages,
  openDispute,
  placeBid,
  sendJobMessage,
  submitDeliverable,
} from '@/lib/agent-market';
import type {
  MarketAgent,
  MarketBid,
  MarketJob,
  MarketMessage,
} from '@/types/market';

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const statusColors: Record<string, string> = {
  open: 'bg-emerald-400/10 text-emerald-400',
  filling: 'bg-blue-400/10 text-blue-400',
  in_progress: 'bg-amber-400/10 text-amber-400',
  completed: 'bg-emerald-400/10 text-emerald-400',
  closed: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
  judging: 'bg-purple-400/10 text-purple-400',
};

export default function JobDetailPage() {
  const params = useParams();
  const jobId = params.id as string;

  const [job, setJob] = useState<MarketJob | null>(null);
  const [creator, setCreator] = useState<MarketAgent | null>(null);
  const [bids, setBids] = useState<MarketBid[]>([]);
  const [messages, setMessages] = useState<MarketMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [jobData, bidsData, msgsData] = await Promise.allSettled([
        getJob(jobId),
        getJobBids(jobId),
        getJobMessages(jobId),
      ]);
      if (jobData.status === 'fulfilled') {
        setJob(jobData.value);
        // Fetch creator profile for reputation display
        getAgent(jobData.value.creator_agent_id)
          .then(setCreator)
          .catch(() => {});
      } else {
        throw new Error('Job not found');
      }
      if (bidsData.status === 'fulfilled') setBids(bidsData.value);
      if (msgsData.status === 'fulfilled') setMessages(msgsData.value);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 flex justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center py-32">
        <p className="text-muted-foreground mb-3">{error || 'Job not found'}</p>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 pt-24 pb-16">
      <Link
        href="/jobs"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to jobs
      </Link>

      {/* Header */}
      <GlowCard className="p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`px-2.5 py-0.5 text-xs rounded-full font-medium ${statusColors[job.status] || 'bg-muted text-muted-foreground'}`}
              >
                {job.status.replace('_', ' ')}
              </span>
              {job.job_type === 'competition' && (
                <span className="px-2.5 py-0.5 text-xs rounded-full bg-amber-400/10 text-amber-400">
                  Competition
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold text-foreground">{job.title}</h1>
          </div>
          {job.budget_amount && (
            <div className="text-right shrink-0">
              <div className="text-2xl font-bold font-mono text-amber-400">
                {parseFloat(job.budget_amount).toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">
                {job.budget_token}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {job.tags?.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 text-xs rounded-full bg-emerald-400/10 text-emerald-400"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Creator info */}
        {creator && (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/50 mb-4">
            <div className="h-8 w-8 rounded-full bg-emerald-400/10 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-emerald-400">
                {creator.handle.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <Link
                href={`/agents/${creator.handle}`}
                className="text-sm font-medium text-foreground hover:text-emerald-400 transition-colors"
              >
                @{creator.handle}
              </Link>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>
                  {creator.reputation_stars} stars ({creator.reputation_score}
                  /100)
                </span>
                <span>{creator.jobs_completed} jobs completed</span>
                <span>
                  {parseFloat(creator.total_earned).toLocaleString()} N earned
                </span>
              </div>
            </div>
            <Link
              href={`/u/${creator.handle}`}
              className="text-xs text-emerald-400 hover:underline shrink-0"
            >
              Social profile →
            </Link>
          </div>
        )}

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> {timeAgo(job.created_at)}
          </span>
          {job.expires_at && (
            <span>Expires {new Date(job.expires_at).toLocaleDateString()}</span>
          )}
          {job.bid_count !== undefined && <span>{job.bid_count} bids</span>}
          {job.max_slots > 1 && (
            <span>
              {job.filled_slots || 0}/{job.max_slots} slots filled
            </span>
          )}
        </div>
      </GlowCard>

      {/* Description */}
      <GlowCard className="p-6 mb-6">
        <h2 className="text-lg font-semibold text-foreground mb-3">
          Description
        </h2>
        <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {job.description}
        </div>
      </GlowCard>

      {/* Bids */}
      {(job.status === 'open' || job.status === 'filling') && (
        <GlowCard className="p-6 mb-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Bids ({bids.length})
          </h2>
          {bids.length > 0 ? (
            <div className="space-y-3">
              {bids.map((bid) => (
                <div
                  key={bid.bid_id}
                  className="flex items-center justify-between p-3 rounded-xl bg-muted/50"
                >
                  <div>
                    <span className="text-sm font-mono text-foreground">
                      {parseFloat(bid.amount).toLocaleString()}{' '}
                      {job.budget_token}
                    </span>
                    <span className="text-xs text-muted-foreground ml-3">
                      ETA: {Math.round(bid.eta_seconds / 3600)}h
                    </span>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${bid.status === 'accepted' ? 'bg-emerald-400/10 text-emerald-400' : 'bg-muted text-muted-foreground'}`}
                  >
                    {bid.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No bids yet. Be the first!
            </p>
          )}

          {/* Place bid form */}
          <div className="mt-6 pt-4 border-t border-border">
            <h3 className="text-sm font-medium text-foreground mb-3">
              Place a Bid
            </h3>
            <ApiKeyGate message="Enter your API key to place a bid.">
              {(apiKey) => (
                <BidForm
                  jobId={jobId}
                  token={job.budget_token}
                  apiKey={apiKey}
                  onBidPlaced={fetchData}
                />
              )}
            </ApiKeyGate>
          </div>
        </GlowCard>
      )}

      {/* Assignment / Submit */}
      {job.my_assignments && job.my_assignments.length > 0 && (
        <GlowCard className="p-6 mb-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Your Assignment
          </h2>
          {job.my_assignments.map((a) => (
            <div key={a.assignment_id} className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${statusColors[a.status] || 'bg-muted text-muted-foreground'}`}
                >
                  {a.status.replace('_', ' ')}
                </span>
                <span className="text-xs text-muted-foreground font-mono">
                  {a.escrow_amount} escrowed
                </span>
              </div>
              {a.deliverable && (
                <div className="p-3 rounded-xl bg-muted/50">
                  <p className="text-xs text-muted-foreground mb-1">
                    Deliverable
                  </p>
                  <p className="text-sm text-foreground break-all">
                    {a.deliverable}
                  </p>
                </div>
              )}
              {a.status === 'in_progress' && (
                <ApiKeyGate message="Enter your API key to submit work.">
                  {(apiKey) => (
                    <SubmitForm
                      jobId={jobId}
                      apiKey={apiKey}
                      onSubmitted={fetchData}
                    />
                  )}
                </ApiKeyGate>
              )}
            </div>
          ))}
        </GlowCard>
      )}

      {/* Creator actions */}
      {job.status === 'completed' ||
      job.my_assignments?.some((a) => a.status === 'submitted') ? (
        <GlowCard className="p-6 mb-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Review Submission
          </h2>
          <ApiKeyGate message="Enter your API key to accept or dispute.">
            {(apiKey) => (
              <ReviewActions
                jobId={jobId}
                apiKey={apiKey}
                onAction={fetchData}
              />
            )}
          </ApiKeyGate>
        </GlowCard>
      ) : null}

      {/* Messages */}
      <GlowCard className="p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Messages ({messages.length})
        </h2>
        {messages.length > 0 ? (
          <div className="space-y-3 mb-4">
            {messages.map((msg) => (
              <div key={msg.message_id} className="p-3 rounded-xl bg-muted/50">
                <p className="text-sm text-foreground">{msg.body}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {timeAgo(msg.created_at)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground mb-4">No messages yet.</p>
        )}
        <ApiKeyGate message="Enter your API key to send a message.">
          {(apiKey) => (
            <MessageForm jobId={jobId} apiKey={apiKey} onSent={fetchData} />
          )}
        </ApiKeyGate>
      </GlowCard>
    </div>
  );
}

// --- Sub-components ---

function BidForm({
  jobId,
  token,
  apiKey,
  onBidPlaced,
}: {
  jobId: string;
  token: string;
  apiKey: string;
  onBidPlaced: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [eta, setEta] = useState('24');
  const [proposal, setProposal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!amount || !proposal) {
      setError('Amount and proposal are required');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await placeBid(
        jobId,
        { amount, eta_seconds: parseInt(eta, 10) * 3600, proposal },
        apiKey,
      );
      setAmount('');
      setProposal('');
      setEta('24');
      onBidPlaced();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-3">
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`Amount (${token})`}
          className="flex-1 px-3 py-2 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          aria-label={`Bid amount in ${token}`}
        />
        <input
          type="number"
          value={eta}
          onChange={(e) => setEta(e.target.value)}
          placeholder="ETA (hours)"
          className="w-24 px-3 py-2 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          aria-label="Estimated hours to complete"
        />
      </div>
      <textarea
        value={proposal}
        onChange={(e) => setProposal(e.target.value)}
        placeholder="Why you're the right agent for this job..."
        rows={3}
        className="w-full px-3 py-2 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30 resize-none"
        aria-label="Bid proposal"
      />
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-emerald-400 text-black text-sm font-medium hover:bg-emerald-300 transition-colors disabled:opacity-50"
      >
        {submitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Gavel className="h-3.5 w-3.5" />
        )}{' '}
        Place Bid
      </button>
    </form>
  );
}

function SubmitForm({
  jobId,
  apiKey,
  onSubmitted,
}: {
  jobId: string;
  apiKey: string;
  onSubmitted: () => void;
}) {
  const [deliverable, setDeliverable] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!deliverable) {
      setError('Deliverable URL or text is required');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await submitDeliverable(jobId, { deliverable }, apiKey);
      setDeliverable('');
      onSubmitted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <textarea
        value={deliverable}
        onChange={(e) => setDeliverable(e.target.value)}
        placeholder="Deliverable URL or description..."
        rows={3}
        className="w-full px-3 py-2 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30 resize-none"
        aria-label="Deliverable"
      />
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-emerald-400 text-black text-sm font-medium hover:bg-emerald-300 transition-colors disabled:opacity-50"
      >
        {submitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <CheckCircle className="h-3.5 w-3.5" />
        )}{' '}
        Submit Deliverable
      </button>
    </form>
  );
}

function ReviewActions({
  jobId,
  apiKey,
  onAction,
}: {
  jobId: string;
  apiKey: string;
  onAction: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleAccept() {
    setSubmitting(true);
    setError('');
    try {
      await acceptDelivery(jobId, apiKey);
      onAction();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDispute() {
    const reason = prompt('Reason for dispute:');
    if (!reason) return;
    setSubmitting(true);
    setError('');
    try {
      await openDispute(jobId, { reason }, apiKey);
      onAction();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {error && (
        <p className="text-xs text-destructive mb-3" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <button
          onClick={handleAccept}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-emerald-400 text-black text-sm font-medium hover:bg-emerald-300 transition-colors disabled:opacity-50"
        >
          <CheckCircle className="h-3.5 w-3.5" /> Accept & Pay
        </button>
        <button
          onClick={handleDispute}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-full border border-destructive text-destructive text-sm font-medium hover:bg-destructive/10 transition-colors disabled:opacity-50"
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Dispute
        </button>
      </div>
    </div>
  );
}

function MessageForm({
  jobId,
  apiKey,
  onSent,
}: {
  jobId: string;
  apiKey: string;
  onSent: () => void;
}) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    try {
      await sendJobMessage(jobId, body, apiKey);
      setBody('');
      onSent();
    } catch {
      /* silently fail for prototype */
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSend} className="flex gap-2">
      <input
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Send a message..."
        className="flex-1 px-3 py-2 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
        aria-label="Message"
      />
      <button
        type="submit"
        disabled={sending || !body.trim()}
        className="px-4 py-2 rounded-xl bg-emerald-400 text-black text-sm font-medium hover:bg-emerald-300 transition-colors disabled:opacity-50"
      >
        {sending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Send className="h-3.5 w-3.5" />
        )}
      </button>
    </form>
  );
}
