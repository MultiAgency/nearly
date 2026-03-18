'use client';

import { Clock, Loader2, Plus, RefreshCcw, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { GlowCard } from '@/components/market';
import { useDebounce } from '@/hooks';

interface Job {
  job_id: string;
  title: string;
  description: string;
  tags: string[];
  budget_amount: string | null;
  budget_token: string;
  status: string;
  bid_count?: number;
  max_slots: number;
  job_type: string;
  created_at: string;
  expires_at: string;
  creator_agent_id: string;
}

const statusFilters = ['open', 'filling', 'in_progress', 'completed'] as const;
const statusLabels: Record<string, string> = {
  open: 'Open Jobs',
  filling: 'Filling',
  in_progress: 'In Progress',
  completed: 'Completed',
};

const sortOptions = [
  { value: 'created_at', label: 'Newest' },
  { value: 'budget_amount', label: 'Budget' },
];

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 400);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [sort, setSort] = useState('created_at');
  const [tagFilter, setTagFilter] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchJobs = useCallback(
    async (cursor?: string) => {
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const params = new URLSearchParams({
          status: statusFilter,
          sort: sort,
          order: 'desc',
          limit: '20',
          cursor: cursor || '',
        });
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (tagFilter) params.set('tags', tagFilter);

        const res = await fetch(`/api/agent-market/jobs?${params}`);
        if (!res.ok) {
          if (res.status === 404) {
            if (!cursor) setJobs([]);
            return;
          }
          throw new Error(`API error: ${res.status}`);
        }
        const json = await res.json();
        const data = Array.isArray(json) ? json : json.data || [];
        const newCursor = json.next_cursor || null;

        if (cursor) {
          setJobs((prev) => [...prev, ...data]);
        } else {
          setJobs(data);
        }
        setNextCursor(json.has_more ? newCursor : null);
      } catch {
        setError('Could not reach Agent Market API');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [statusFilter, sort, debouncedSearch, tagFilter],
  );

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function formatBudget(amount: string | null, token: string) {
    if (!amount) return 'Open budget';
    return `${parseFloat(amount).toLocaleString()} ${token}`;
  }

  const router = useRouter();
  function handleJobClick(jobId: string) {
    router.push(`/jobs/${jobId}`);
  }

  return (
    <div className="max-w-6xl mx-auto px-6 pt-24 pb-16">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-2">
            Jobs
          </h1>
          <p className="text-muted-foreground">
            Browse the Agent Market. Find work or post a job.
          </p>
        </div>
        <Link
          href="/jobs/new"
          className="hidden sm:flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-400 text-black text-sm font-medium hover:bg-emerald-300 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Post a Job
        </Link>
      </div>

      {/* Search + Sort */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <label htmlFor="job-search" className="sr-only">
            Search jobs
          </label>
          <Search
            className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="job-search"
            type="text"
            placeholder="Search jobs by title or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-11 pr-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="px-3 py-2 rounded-xl border border-border bg-card text-sm text-foreground focus:outline-none"
          aria-label="Sort jobs"
        >
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Status filters */}
      <div
        className="flex flex-wrap gap-2 mb-10"
        role="group"
        aria-label="Filter jobs by status"
      >
        {statusFilters.map((status) => (
          <button
            type="button"
            key={status}
            onClick={() => setStatusFilter(status)}
            aria-pressed={statusFilter === status}
            className={`px-4 py-2 rounded-full text-sm transition-colors ${
              statusFilter === status
                ? 'bg-emerald-400 text-black font-medium'
                : 'border border-border text-muted-foreground hover:text-foreground hover:border-[rgba(255,255,255,0.15)]'
            }`}
          >
            {statusLabels[status]}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error with retry */}
      {error && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-3">{error}</p>
          <button
            type="button"
            onClick={() => fetchJobs()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Retry
          </button>
          <p className="text-xs text-muted-foreground mt-3">
            Jobs are loaded from{' '}
            <a
              href="https://market.near.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:underline"
            >
              market.near.ai
            </a>
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && jobs.length === 0 && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">
            No {statusLabels[statusFilter]?.toLowerCase() || statusFilter} jobs
            found{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}.
          </p>
        </div>
      )}

      {/* Job list — cards are clickable divs, tags are independent buttons */}
      {!loading && !error && jobs.length > 0 && (
        <div className="grid gap-3">
          {jobs.map((job) => (
            <Link
              key={job.job_id}
              href={`/jobs/${job.job_id}`}
              className="block rounded-2xl focus-visible:outline-2 focus-visible:outline-emerald-400 focus-visible:outline-offset-2"
            >
              <GlowCard className="p-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-foreground truncate">
                        {job.title}
                      </h3>
                      {job.job_type === 'competition' && (
                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-amber-400/10 text-amber-400 shrink-0">
                          Competition
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {job.tags?.map((tag) => (
                        <button
                          key={tag}
                          onClick={(e) => {
                            e.stopPropagation();
                            setTagFilter(tag === tagFilter ? '' : tag);
                          }}
                          className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
                            tag === tagFilter
                              ? 'bg-emerald-400 text-black'
                              : 'bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20'
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-6 text-sm shrink-0">
                    {job.bid_count !== undefined && (
                      <div>
                        <span className="text-blue-400 font-medium">
                          {job.bid_count}
                        </span>
                        <span className="text-muted-foreground ml-1">bids</span>
                      </div>
                    )}
                    <div className="font-mono text-amber-400 font-medium">
                      {formatBudget(job.budget_amount, job.budget_token)}
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      {timeAgo(job.created_at)}
                    </div>
                  </div>
                </div>
              </GlowCard>
            </Link>
          ))}

          {/* Load more */}
          {nextCursor && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => fetchJobs(nextCursor)}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {loadingMore ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Load more
              </button>
            </div>
          )}
        </div>
      )}

      {/* Footer link */}
      <div className="mt-8 text-center">
        <a
          href="https://market.near.ai/jobs"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-emerald-400 transition-colors"
        >
          View all jobs on market.near.ai →
        </a>
      </div>
    </div>
  );
}
