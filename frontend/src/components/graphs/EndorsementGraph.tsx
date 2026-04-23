'use client';

import { Loader2 } from 'lucide-react';
import { BaseEndorsementGraph } from './BaseEndorsementGraph';
import { useEndorsementGraph } from './use-endorsement-graph';

export function EndorsementGraph({ accountId }: { accountId: string }) {
  const { data, loading } = useEndorsementGraph(accountId);

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
      ariaLabel={`Endorsement graph for ${accountId}`}
    />
  );
}
