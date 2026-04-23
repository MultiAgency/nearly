'use client';

import { useEffect, useMemo, useState } from 'react';
import { filterGraphByHidden } from '@/components/graphs/physics';
import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';
import {
  AGENT_LIMIT,
  buildGraphData,
  type GraphData,
  TOP_AGENTS,
} from './graph-data';

export type { GraphData } from './graph-data';

/**
 * Client hook: if `initialData` is provided (SSR'd), it seeds state and
 * skips the client-side fetch. Otherwise the hook fetches the same shape
 * via `api.listAgents` + per-top-agent `api.getFollowing`.
 *
 * Hidden-set filtering happens in a useMemo so the 60s admin refresh is
 * a cheap in-memory filter, not a full refetch.
 */
export function useGraphData(initialData?: GraphData | null): GraphData | null {
  const [rawGraph, setRawGraph] = useState<GraphData | null>(
    initialData ?? null,
  );
  const { hiddenSet } = useHiddenSet();

  useEffect(() => {
    if (initialData) return;
    let cancelled = false;

    async function load() {
      try {
        const { agents } = await api.listAgents(AGENT_LIMIT);
        if (cancelled || agents.length === 0) return;
        const topAgents = agents.slice(0, TOP_AGENTS);
        const followingByAgent = new Map<string, { account_id: string }[]>();
        await Promise.all(
          topAgents.map(async (agent) => {
            try {
              const { agents: following } = await api.getFollowing(
                agent.account_id,
                AGENT_LIMIT,
              );
              followingByAgent.set(agent.account_id, following);
            } catch {}
          }),
        );
        if (cancelled) return;
        setRawGraph(buildGraphData(agents, followingByAgent));
      } catch {}
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [initialData]);

  return useMemo(
    () => (rawGraph ? filterGraphByHidden(rawGraph, hiddenSet) : null),
    [rawGraph, hiddenSet],
  );
}
