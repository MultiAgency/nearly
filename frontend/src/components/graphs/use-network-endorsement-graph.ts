'use client';

import { useEffect, useMemo, useState } from 'react';
import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';
import type {
  EndorsementGraphData,
  EndorsementGraphEdge,
  EndorsementRenderNode,
} from './endorsement-physics';
import { filterGraphByHidden } from './physics';

const AGENT_LIMIT = 30;
const EDGE_SCAN_LIMIT = 12;

export interface NetworkEndorsementGraphState {
  data: EndorsementGraphData | null;
  loading: boolean;
}

/**
 * Fetch endorsement edges across all active agents.
 * Lists agents, then scans outgoing endorsements for the top N.
 * Returns { data, loading } so the consumer can distinguish "still fetching"
 * from "fetched but empty" — mirrors `useEndorsementGraph`.
 */
export function useNetworkEndorsementGraph(): NetworkEndorsementGraphState {
  const [raw, setRaw] = useState<EndorsementGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const { hiddenSet } = useHiddenSet();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRaw(null);

    async function load() {
      try {
        const { agents } = await api.listAgents(AGENT_LIMIT);
        if (cancelled || agents.length === 0) return;

        const agentMap = new Map(agents.map((a) => [a.account_id, a]));
        const edgeKey = new Set<string>();
        const edges: EndorsementGraphEdge[] = [];

        // Scan outgoing endorsements for the top agents
        const scanAgents = agents.slice(0, EDGE_SCAN_LIMIT);
        await Promise.all(
          scanAgents.map(async (agent) => {
            try {
              const res = await api.getEndorsing(agent.account_id);
              const endorsing = res.endorsing ?? {};
              for (const [targetId, group] of Object.entries(endorsing)) {
                const key = `${agent.account_id}->${targetId}`;
                if (edgeKey.has(key)) continue;
                edgeKey.add(key);
                const suffixes = group.entries.map((e) => e.key_suffix);
                edges.push({
                  from: agent.account_id,
                  to: targetId,
                  suffixes,
                  weight: suffixes.length,
                  direction: 'outgoing',
                });
              }
            } catch {
              // Skip agents whose endorsing read fails
            }
          }),
        );

        if (cancelled) return;

        // Build node set: all agents from the list + any targets discovered by edges
        const nodeIds = new Set<string>();
        for (const a of agents) nodeIds.add(a.account_id);
        for (const e of edges) {
          nodeIds.add(e.from);
          nodeIds.add(e.to);
        }

        const ids = [...nodeIds];
        const nodes: EndorsementRenderNode[] = ids.map((id, i) => {
          const agent = agentMap.get(id);
          const angle =
            (i / ids.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
          const r = 0.2 + Math.random() * 0.2;
          return {
            id,
            x: 0.5 + Math.cos(angle) * r,
            y: 0.5 + Math.sin(angle) * r,
            vx: 0,
            vy: 0,
            radius: 5,
            label: agent?.name || id,
            role: 'neutral' as const,
          };
        });

        const nodeSet = new Set(ids);
        const visibleEdges = edges.filter(
          (e) => nodeSet.has(e.from) && nodeSet.has(e.to),
        );
        setRaw({ nodes, edges: visibleEdges });
      } catch {
        // Leave null on failure
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(
    () => (raw ? filterGraphByHidden(raw, hiddenSet) : null),
    [raw, hiddenSet],
  );

  return { data: filtered, loading };
}
