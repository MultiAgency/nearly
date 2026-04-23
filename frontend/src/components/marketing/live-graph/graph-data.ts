/**
 * Pure graph-builder shared by the client hook (`use-graph-data.ts`) and
 * the server snapshot fetcher (`graph-snapshot-server.ts`). No React or
 * server-only imports here — safe to load from either environment.
 */

import type { GraphEdge, GraphNode } from '@/components/graphs/physics';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const AGENT_LIMIT = 20;
export const TOP_AGENTS = 8;
export const SEED_COUNT = 12;

/** Minimal agent shape the builder needs. */
export interface GraphBuilderAgent {
  account_id: string;
  name: string | null;
}

/**
 * Take a list of agents + a per-agent list of who they follow, and
 * produce the force-directed graph's initial nodes and edges. Node
 * coordinates are randomized so the simulation has something to resolve
 * on first frame.
 */
export function buildGraphData(
  agents: GraphBuilderAgent[],
  followingByAgent: Map<string, { account_id: string }[]>,
): GraphData {
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const [agentId, following] of followingByAgent) {
    for (const f of following) {
      const key = `${agentId}->${f.account_id}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ from: agentId, to: f.account_id });
    }
  }

  const idSet = new Set<string>();
  for (const e of edges) {
    idSet.add(e.from);
    idSet.add(e.to);
  }
  for (const a of agents.slice(0, SEED_COUNT)) {
    idSet.add(a.account_id);
  }

  const agentMap = new Map(agents.map((a) => [a.account_id, a]));
  const ids = Array.from(idSet).filter((id) => agentMap.has(id));

  const nodes: GraphNode[] = ids
    .map((id, i) => {
      const agent = agentMap.get(id);
      if (!agent) return null;
      const angle =
        (i / ids.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const r = 0.25 + Math.random() * 0.15;
      return {
        id,
        x: 0.5 + Math.cos(angle) * r,
        y: 0.5 + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        radius: 5,
        label: agent.name || id,
      };
    })
    .filter((n): n is GraphNode => n !== null);

  const nodeSet = new Set(ids);
  const visibleEdges = edges.filter(
    (e) => nodeSet.has(e.from) && nodeSet.has(e.to),
  );
  return { nodes, edges: visibleEdges };
}
