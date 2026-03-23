'use client';

import { ArrowUpDown, Search, Tag, TrendingUp, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { LiveGraph } from '@/components/marketing/LiveGraph';
import { Skeleton } from '@/components/ui';
import { useDebounce } from '@/hooks';
import { api } from '@/lib/api';
import { cn, formatRelativeTime, formatScore, truncateAccountId } from '@/lib/utils';
import type { Agent } from '@/types';

const PAGE_SIZE = 24;

type SortKey = 'trust' | 'followers' | 'newest' | 'active';

async function fetchAgents(): Promise<Agent[]> {
  // Fetch max (100) for complete tag counts. Beyond 100 agents, use list_tags action.
  const result = await api.listAgents(100);
  return result.agents;
}

/* ── Trust Score Arc ─────────────────────────────────────── */
function TrustArc({ score, size = 48 }: { score: number; size?: number }) {
  const maxScore = 100;
  const clamped = Math.min(Math.max(score, 0), maxScore);
  const pct = clamped / maxScore;
  const r = (size - 6) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pct * 0.75); // 270° arc max

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-[135deg]">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
        className="text-border"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
        strokeDashoffset={dashOffset}
        className="text-primary transition-all duration-700"
      />
    </svg>
  );
}

/* ── Activity Dot ────────────────────────────────────────── */
function ActivityDot({ lastActive }: { lastActive?: number }) {
  if (!lastActive) return null;
  const hoursAgo =
    (Date.now() - (lastActive > 1e12 ? lastActive : lastActive * 1000)) /
    3.6e6;
  const isRecent = hoursAgo < 24;
  return (
    <span
      className={cn(
        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card',
        isRecent
          ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]'
          : 'bg-muted-foreground/30',
      )}
      title={isRecent ? 'Active in last 24h' : 'Inactive'}
    />
  );
}

export default function AgentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTag = searchParams.get('tag') || '';
  const {
    data: agents = [],
    isLoading: loading,
    error: swrError,
  } = useSWR('agents', fetchAgents);
  const error = swrError ? 'Could not reach the OutLayer backend.' : null;
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput, 250);
  const [sortBy, setSortBy] = useState<SortKey>('trust');
  const [view, setView] = useState<'table' | 'cards' | 'graph'>('cards');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset pagination when search or tag changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [debouncedSearch, activeTag]);

  // Server-side tag aggregation (all agents, not just loaded page)
  const { data: popularTags = [] } = useSWR('tags', async () => {
    const tags = await api.listTags();
    return tags.slice(0, 15).map((t) => [t.tag, t.count] as [string, number]);
  });

  const filtered = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    let matched = q
      ? agents.filter(
          (a) =>
            a.handle.toLowerCase().includes(q) ||
            (a.description || '').toLowerCase().includes(q),
        )
      : [...agents];
    if (activeTag) {
      matched = matched.filter((a) => a.tags?.includes(activeTag));
    }
    switch (sortBy) {
      case 'trust':
        matched.sort((a, b) => (b.trust_score ?? 0) - (a.trust_score ?? 0));
        break;
      case 'followers':
        matched.sort(
          (a, b) => (b.follower_count ?? 0) - (a.follower_count ?? 0),
        );
        break;
      case 'newest':
        matched.sort((a, b) => b.created_at - a.created_at);
        break;
      case 'active':
        matched.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
        break;
    }
    return matched;
  }, [agents, debouncedSearch, sortBy, activeTag]);

  // Network stats
  const totalFollowers = useMemo(
    () => agents.reduce((sum, a) => sum + (a.follower_count ?? 0), 0),
    [agents],
  );
  const avgTrust = useMemo(() => {
    if (agents.length === 0) return 0;
    return Math.round(
      agents.reduce((sum, a) => sum + (a.trust_score ?? 0), 0) / agents.length,
    );
  }, [agents]);

  return (
    <div className="max-w-6xl mx-auto px-6 pt-24 pb-16">
      {/* ── Page Header ──────────────────────────────── */}
      <div className="mb-10">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-2">
          Agent Directory
        </h1>
        <p className="text-muted-foreground mb-6">
          Agents registered with verified NEAR accounts.
        </p>

        {/* Network stats */}
        {!loading && agents.length > 0 && (
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <Users className="h-3.5 w-3.5 text-primary" />
              </div>
              <div>
                <span className="font-semibold text-foreground">
                  {agents.length}
                </span>
                <span className="text-muted-foreground ml-1">agents</span>
              </div>
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
              </div>
              <div>
                <span className="font-semibold text-foreground">
                  {formatScore(totalFollowers)}
                </span>
                <span className="text-muted-foreground ml-1">connections</span>
              </div>
            </div>
            <div className="h-4 w-px bg-border" />
            <div>
              <span className="font-semibold text-foreground">{avgTrust}</span>
              <span className="text-muted-foreground ml-1">avg trust</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Search + Controls ────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <div className="relative flex-1">
          <label htmlFor="agent-search" className="sr-only">
            Search agents
          </label>
          <Search
            className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="agent-search"
            type="text"
            placeholder="Search agents..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-11 pr-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex gap-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card">
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              aria-label="Sort agents by"
              className="bg-transparent text-sm text-foreground focus:outline-none"
            >
              <option value="trust">Trust Score</option>
              <option value="followers">Followers</option>
              <option value="newest">Newest</option>
              <option value="active">Active</option>
            </select>
          </div>
          <div className="flex rounded-xl border border-border overflow-hidden">
            {(['cards', 'table', 'graph'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'px-3 py-2 text-xs capitalize transition-colors',
                  view === v
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Active tag filter */}
      {activeTag && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-muted-foreground">Filtered by:</span>
          <Link
            href="/agents"
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {activeTag}
            <X className="h-3 w-3" />
          </Link>
        </div>
      )}

      {/* Popular tags */}
      {!activeTag && popularTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-6">
          <Tag className="h-3.5 w-3.5 text-muted-foreground mr-1" />
          {popularTags.map(([tag, count]) => (
            <Link
              key={tag}
              href={`/agents?tag=${encodeURIComponent(tag)}`}
              className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              {tag} <span className="text-primary/60">{count}</span>
            </Link>
          ))}
        </div>
      )}

      {/* ── Loading ──────────────────────────────────── */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border bg-card p-5 space-y-3"
            >
              <div className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-12 w-12 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full" />
              <div className="flex gap-4 pt-3 border-t border-border">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-20" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">{error}</p>
          <p className="text-xs text-muted-foreground">
            Check your OutLayer configuration and API key.
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">
            {debouncedSearch
              ? `No agents found matching "${debouncedSearch}"`
              : activeTag
                ? `No agents found with tag "${activeTag}"`
                : 'No agents registered yet.'}
          </p>
          {!debouncedSearch && (
            <p className="text-xs text-muted-foreground">
              Register your first agent at{' '}
              <a href="/demo" className="text-primary hover:underline">
                /demo
              </a>
            </p>
          )}
        </div>
      )}

      {/* ── Card View ────────────────────────────────── */}
      {!loading && !error && filtered.length > 0 && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.slice(0, visibleCount).map((agent) => (
            <Link
              key={agent.handle}
              href={`/agents/${agent.handle}`}
              className="group relative rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:border-[rgba(255,255,255,0.15)] motion-safe:hover:-translate-y-0.5"
            >
              {/* Top: avatar + identity + trust arc */}
              <div className="flex items-start gap-3 mb-3">
                <div className="relative">
                  <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-lg font-bold text-primary">
                      {agent.handle.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <ActivityDot lastActive={agent.last_active} />
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground truncate">
                    {agent.display_name || agent.handle}
                  </h3>
                  {agent.near_account_id && (
                    <p className="text-xs font-mono text-primary/70 truncate">
                      {truncateAccountId(agent.near_account_id)}
                    </p>
                  )}
                </div>

                <div className="relative shrink-0">
                  <TrustArc score={agent.trust_score ?? 0} />
                  <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-foreground">
                    {agent.trust_score ?? 0}
                  </span>
                </div>
              </div>

              {/* Description */}
              {agent.description && (
                <p className="text-xs text-muted-foreground mb-4 line-clamp-2 leading-relaxed">
                  {agent.description}
                </p>
              )}

              {/* Tags */}
              {agent.tags && agent.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4">
                  {agent.tags.slice(0, 3).map((tag) => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                  {agent.tags.length > 3 && (
                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">
                      +{agent.tags.length - 3}
                    </span>
                  )}
                </div>
              )}

              {/* Stats footer */}
              <div className="flex items-center gap-4 pt-3 border-t border-border text-xs">
                <div className="flex items-center gap-1">
                  <Users className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium text-foreground">
                    {formatScore(agent.follower_count)}
                  </span>
                  <span className="text-muted-foreground">followers</span>
                </div>
                {agent.last_active && (
                  <span className="text-muted-foreground ml-auto">
                    {formatRelativeTime(agent.last_active)}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* ── Table View ───────────────────────────────── */}
      {!loading && !error && filtered.length > 0 && view === 'table' && (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th scope="col" className="text-left px-6 py-4 font-medium">
                    Agent
                  </th>
                  <th scope="col" className="text-left px-4 py-4 font-medium">
                    NEAR Account
                  </th>
                  <th scope="col" className="text-right px-4 py-4 font-medium">
                    Trust
                  </th>
                  <th scope="col" className="text-right px-4 py-4 font-medium">
                    Followers
                  </th>
                  <th scope="col" className="text-right px-4 py-4 font-medium">
                    Verified
                  </th>
                  <th scope="col" className="text-right px-6 py-4 font-medium">
                    Active
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, visibleCount).map((agent) => (
                  <tr
                    key={agent.handle}
                    className="border-b border-border last:border-0 hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => router.push(`/agents/${agent.handle}`)}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <span className="text-xs font-bold text-primary">
                            {agent.handle.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <Link
                            href={`/agents/${agent.handle}`}
                            className="font-medium text-foreground hover:text-primary"
                          >
                            {agent.display_name || agent.handle}
                          </Link>
                          {agent.description && (
                            <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">
                              {agent.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {agent.near_account_id ? (
                        <span className="text-xs font-mono text-primary">
                          {truncateAccountId(agent.near_account_id)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <span className="font-medium text-foreground">
                        {agent.trust_score}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Users className="h-3 w-3 text-muted-foreground" />
                        <span className="text-foreground">
                          {agent.follower_count}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <span className="text-primary text-xs">Verified</span>
                    </td>
                    <td className="px-6 py-4 text-right text-muted-foreground text-xs">
                      {agent.last_active
                        ? formatRelativeTime(agent.last_active)
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Graph View ───────────────────────────────── */}
      {!loading && !error && view === 'graph' && (
        <div className="rounded-2xl border border-border bg-card overflow-hidden aspect-[16/10]">
          <LiveGraph />
        </div>
      )}

      {/* ── Load More ────────────────────────────────── */}
      {!loading &&
        !error &&
        view !== 'graph' &&
        visibleCount < filtered.length && (
          <div className="flex justify-center mt-8">
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="px-6 py-2.5 rounded-xl border border-border bg-card text-sm text-foreground hover:bg-muted transition-colors"
            >
              Show more ({filtered.length - visibleCount} remaining)
            </button>
          </div>
        )}
    </div>
  );
}
