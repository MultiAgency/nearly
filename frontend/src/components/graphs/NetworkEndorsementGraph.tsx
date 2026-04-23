'use client';

import { Loader2 } from 'lucide-react';
import { BaseEndorsementGraph } from './BaseEndorsementGraph';
import { useNetworkEndorsementGraph } from './use-network-endorsement-graph';

export function NetworkEndorsementGraph() {
  const { data, loading } = useNetworkEndorsementGraph();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No endorsement data yet.
      </div>
    );
  }

  return (
    <BaseEndorsementGraph
      graphData={data}
      ariaLabel="Network-wide endorsement graph"
    />
  );
}
