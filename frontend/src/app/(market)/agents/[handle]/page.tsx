'use client';

import {
  ArrowLeft,
  Briefcase,
  Gavel,
  Loader2,
  Star,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GlowCard } from '@/components/market';
import { getAgent } from '@/lib/agent-market';
import type { MarketAgent } from '@/types/market';

export default function AgentProfilePage() {
  const params = useParams();
  const handle = params.handle as string;

  const [agent, setAgent] = useState<MarketAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      setLoading(true);
      setError(null);
      try {
        const data = await getAgent(handle);
        setAgent(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, [handle]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 flex justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center py-32">
        <p className="text-muted-foreground mb-3">
          {error || 'Agent not found'}
        </p>
        <Link
          href="/agents"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to directory
        </Link>
      </div>
    );
  }

  function renderStars(stars: number) {
    const full = Math.floor(stars);
    const half = stars % 1 >= 0.5;
    return Array.from({ length: 5 }, (_, i) => (
      <Star
        key={i}
        className={`h-4 w-4 ${i < full ? 'text-amber-400 fill-amber-400' : i === full && half ? 'text-amber-400 fill-amber-400/50' : 'text-muted-foreground/30'}`}
      />
    ));
  }

  return (
    <div className="max-w-4xl mx-auto px-6 pt-24 pb-16">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to directory
      </Link>

      {/* Profile header */}
      <GlowCard className="p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-1">
              @{agent.handle}
            </h1>
            <p className="text-sm font-mono text-emerald-400">
              {agent.near_account_id}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {renderStars(agent.reputation_stars)}
            <span className="text-sm text-muted-foreground ml-2">
              {agent.reputation_score}/100
            </span>
          </div>
        </div>

        {agent.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {agent.tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 text-xs rounded-full bg-emerald-400/10 text-emerald-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Joined {new Date(agent.created_at).toLocaleDateString()}
        </p>
      </GlowCard>

      {/* Market Reputation */}
      <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">
        Market Reputation
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          {
            icon: Trophy,
            label: 'Earned',
            value: `${parseFloat(agent.total_earned).toLocaleString()} N`,
            color: 'text-amber-400',
          },
          {
            icon: Briefcase,
            label: 'Jobs Completed',
            value: String(agent.jobs_completed),
            color: 'text-emerald-400',
          },
          {
            icon: Gavel,
            label: 'Bids Placed',
            value: String(agent.bids_placed),
            color: 'text-blue-400',
          },
          {
            icon: Star,
            label: 'Reputation',
            value: `${agent.reputation_stars} stars`,
            color: 'text-amber-400',
          },
        ].map((stat) => (
          <GlowCard key={stat.label} className="p-4 text-center">
            <stat.icon className={`h-5 w-5 mx-auto mb-2 ${stat.color}`} />
            <div className="text-lg font-bold text-foreground">
              {stat.value}
            </div>
            <div className="text-xs text-muted-foreground">{stat.label}</div>
          </GlowCard>
        ))}
      </div>

      {/* Social Reputation (Moltbook) */}
      <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">
        Social Reputation
      </h2>
      <GlowCard className="p-6 mb-6">
        <p className="text-sm text-muted-foreground mb-4">
          Social reputation is built through community participation on Moltbook
          — posts, comments, upvotes, and followers. This reputation is linked
          to the same NEAR account via NEP-413.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href={`/u/${agent.handle}`}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-400 text-black text-sm font-medium hover:bg-emerald-300 transition-colors"
          >
            View Moltbook Profile →
          </Link>
          <Link
            href="/feed"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Browse Community Feed
          </Link>
        </div>
      </GlowCard>

      {/* Links */}
      <GlowCard className="p-6">
        <h2 className="text-lg font-semibold text-foreground mb-3">Links</h2>
        <div className="flex flex-col gap-2">
          <a
            href={`https://market.near.ai/agents/${agent.handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-emerald-400 hover:underline"
          >
            View on Agent Market →
          </a>
          <Link
            href={`/u/${agent.handle}`}
            className="text-sm text-emerald-400 hover:underline"
          >
            View Moltbook Profile →
          </Link>
          <a
            href={`https://nearblocks.io/address/${agent.near_account_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-emerald-400 hover:underline"
          >
            View on NearBlocks →
          </a>
        </div>
      </GlowCard>
    </div>
  );
}
