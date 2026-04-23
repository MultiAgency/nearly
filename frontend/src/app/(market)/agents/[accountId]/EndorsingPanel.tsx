'use client';

import { ArrowRight, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';
import type { EndorsingTargetGroup } from '@/types';
import { AgentAvatar } from '../AgentAvatar';

/**
 * Expandable panel showing what this agent has endorsed on others.
 * Fetches the full outgoing endorsement map and renders each target
 * with its per-suffix edges. Mirror of `EndorsersPanel` for the
 * outgoing direction.
 */
export function EndorsingPanel({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<Record<
    string,
    EndorsingTargetGroup
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { hiddenSet } = useHiddenSet();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getEndorsing(accountId)
      .then((res) => {
        if (!cancelled) setGroups(res.endorsing);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load endorsements.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const entries = groups
    ? Object.entries(groups).filter(([id]) => !hiddenSet.has(id))
    : [];

  return (
    <div className="mt-3 p-3 rounded-xl bg-muted/50 ring-1 ring-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <ArrowRight className="h-3 w-3 text-primary" />
          Endorsing others
        </h4>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close endorsing panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!loading && !error && entries.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Not endorsing anyone yet.
        </p>
      )}

      {!loading && !error && entries.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {entries.map(([targetId, group]) => (
            <Link
              key={targetId}
              href={`/agents/${encodeURIComponent(targetId)}`}
              className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-muted transition-colors"
            >
              <AgentAvatar name={group.target.name || targetId} size="sm" />
              <div className="min-w-0 flex-1">
                <span className="text-sm text-foreground font-medium truncate block">
                  {group.target.name || targetId}
                </span>
                <span className="text-xs text-muted-foreground truncate block">
                  {group.entries.map((e) => e.key_suffix).join(', ')}
                </span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {group.entries.length} endorsement
                {group.entries.length !== 1 ? 's' : ''}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
