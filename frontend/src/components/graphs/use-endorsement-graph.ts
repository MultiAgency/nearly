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

export interface EndorsementGraphState {
  data: EndorsementGraphData | null;
  loading: boolean;
}

/**
 * Fetch the 1-hop endorsement neighborhood for a single agent.
 * Calls getEndorsers + getEndorsing in parallel, builds nodes + edges.
 * Returns { data, loading } so the consumer can distinguish "still fetching"
 * from "fetched but empty".
 */
export function useEndorsementGraph(accountId: string): EndorsementGraphState {
  const [raw, setRaw] = useState<EndorsementGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const { hiddenSet } = useHiddenSet();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRaw(null);

    async function load() {
      try {
        const [endorsersRes, endorsingRes] = await Promise.all([
          api.getEndorsers(accountId),
          api.getEndorsing(accountId),
        ]);

        if (cancelled) return;

        const nodeIds = new Set<string>();
        nodeIds.add(accountId);

        // Map node id → display name (best-effort from response data)
        const nameMap = new Map<string, string>();

        const edges: EndorsementGraphEdge[] = [];

        // Track which nodes are endorsers vs targets
        const endorserIds = new Set<string>();
        const targetIds = new Set<string>();

        // Incoming: endorsers → center
        const endorsers = endorsersRes.endorsers ?? {};
        const incomingByEndorser = new Map<string, string[]>();
        for (const [suffix, entries] of Object.entries(endorsers)) {
          for (const entry of entries) {
            nodeIds.add(entry.account_id);
            endorserIds.add(entry.account_id);
            if (entry.name) nameMap.set(entry.account_id, entry.name);
            const existing = incomingByEndorser.get(entry.account_id);
            if (existing) {
              existing.push(suffix);
            } else {
              incomingByEndorser.set(entry.account_id, [suffix]);
            }
          }
        }
        for (const [endorserId, suffixes] of incomingByEndorser) {
          edges.push({
            from: endorserId,
            to: accountId,
            suffixes,
            weight: suffixes.length,
            direction: 'incoming',
          });
        }

        // Outgoing: center → targets
        const endorsing = endorsingRes.endorsing ?? {};
        for (const [targetId, group] of Object.entries(endorsing)) {
          nodeIds.add(targetId);
          targetIds.add(targetId);
          if (group.target.name) nameMap.set(targetId, group.target.name);
          const suffixes = group.entries.map((e) => e.key_suffix);
          edges.push({
            from: accountId,
            to: targetId,
            suffixes,
            weight: suffixes.length,
            direction: 'outgoing',
          });
        }

        // Build nodes in a ring around center
        const ids = [...nodeIds];
        const others = ids.filter((id) => id !== accountId);
        const nodes: EndorsementRenderNode[] = [
          {
            id: accountId,
            x: 0.5,
            y: 0.5,
            vx: 0,
            vy: 0,
            radius: 8,
            label: nameMap.get(accountId) || accountId,
            role: 'center',
          },
        ];
        for (let i = 0; i < others.length; i++) {
          const id = others[i];
          const angle =
            (i / others.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
          const r = 0.2 + Math.random() * 0.15;
          const role = endorserIds.has(id)
            ? 'endorser'
            : targetIds.has(id)
              ? 'target'
              : 'neutral';
          nodes.push({
            id,
            x: 0.5 + Math.cos(angle) * r,
            y: 0.5 + Math.sin(angle) * r,
            vx: 0,
            vy: 0,
            radius: 5,
            label: nameMap.get(id) || id,
            role,
          });
        }

        setRaw({ nodes, edges });
      } catch {
        // Either fetch failed — leave null so the consumer shows an empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const filtered = useMemo(
    () => (raw ? filterGraphByHidden(raw, hiddenSet) : null),
    [raw, hiddenSet],
  );

  return { data: filtered, loading };
}
