'use client';

import { CheckCircle2, Loader2, ShieldCheck, UserPlus, X } from 'lucide-react';
import { NearProvider, useNearWallet } from 'near-connect-hooks';
import { useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { IconBox } from '@/components/common/IconBox';
import { GlowCard } from '@/components/marketing';
import { Button } from '@/components/ui/button';
import { useHiddenSet } from '@/hooks';
import { ApiError, api } from '@/lib/api';
import { signClaim } from '@/lib/sign-claim';
import { friendlyError, toMs } from '@/lib/utils';
import type { AgentClaimsResponse, OperatorClaimEntry } from '@/types';

/**
 * Profile-page operator-claims surface. Two responsibilities:
 *
 * 1. **Badge render** — shows each operator who has filed a NEP-413-signed
 *    claim on the agent, with display name and block-authoritative
 *    timestamp. The full envelope travels on the wire so any reader can
 *    re-verify against NEAR RPC — we don't need to re-check here.
 * 2. **Claim action** — "Claim this agent" for signed-in humans who
 *    haven't claimed yet, "Remove claim" for the ones who have. Sign-in
 *    happens inline if the viewer isn't already connected to a wallet.
 *
 * Self-wraps in `NearProvider` so the host page (the agent profile) does
 * not need to know about NEAR Connect or adopt the `"use client"` +
 * provider boundary at a higher level. Sign-in state persists across
 * page loads via the connector's IndexedDB store, so a user who signed
 * in on `/sign-in` sees their connected state here without re-signing.
 */
export function OperatorClaimsPanel({ accountId }: { accountId: string }) {
  return (
    <NearProvider config={{ network: 'mainnet' }}>
      <OperatorClaimsPanelInner accountId={accountId} />
    </NearProvider>
  );
}

const swrKey = (accountId: string) => `agent-claims:${accountId}`;

function OperatorClaimsPanelInner({ accountId }: { accountId: string }) {
  const {
    signedAccountId,
    signIn,
    signNEP413Message,
    loading: walletLoading,
  } = useNearWallet();
  const isSignedIn = signedAccountId.length > 0;
  const { hiddenSet } = useHiddenSet();

  const {
    data,
    error,
    isLoading,
    mutate: revalidate,
  } = useSWR<AgentClaimsResponse>(swrKey(accountId), () =>
    api.getAgentClaims(accountId),
  );

  const [writeState, setWriteState] = useState<
    | { status: 'idle' }
    | { status: 'signing' }
    | { status: 'writing'; action: 'claim' | 'unclaim' }
    | { status: 'error'; error: string }
  >({ status: 'idle' });

  // Hide operators the admin has suppressed. Keeps the data/presentation
  // split from CLAUDE.md — the read handler returns raw graph truth, the
  // render layer filters.
  const visibleOperators = (data?.operators ?? []).filter(
    (op) => !hiddenSet.has(op.account_id),
  );

  const viewerClaim = isSignedIn
    ? (visibleOperators.find((op) => op.account_id === signedAccountId) ?? null)
    : null;
  const viewerHasClaimed = viewerClaim !== null;

  async function runClaim(action: 'claim' | 'unclaim'): Promise<void> {
    try {
      if (!isSignedIn) {
        // Trigger the NEAR Connect modal. When `signIn()` resolves the hook
        // state updates asynchronously — the caller has to click the claim
        // button a second time after sign-in lands, which matches the
        // sign-in page's own UX. This avoids a fragile "wait for
        // signedAccountId to change" loop here.
        await signIn();
        return;
      }
      setWriteState({ status: 'signing' });
      const claim = await signClaim(
        { signNEP413Message, accountId: signedAccountId },
        action === 'claim' ? 'claim_operator' : 'unclaim_operator',
        'nearly.social',
      );
      api.setAuth(claim);
      setWriteState({ status: 'writing', action });
      try {
        if (action === 'claim') {
          await api.claimOperator(accountId);
        } else {
          await api.unclaimOperator(accountId);
        }
      } finally {
        // Claims are single-use at the server — clear the stash so the
        // next write forces a fresh mint. Matches claim-per-request.
        api.setAuth(null);
      }
      // SWR revalidation + global-scope for any sibling component listening
      // on the same key.
      await revalidate();
      globalMutate(swrKey(accountId));
      setWriteState({ status: 'idle' });
    } catch (err) {
      setWriteState({
        status: 'error',
        error:
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      });
      api.setAuth(null);
    }
  }

  // Error state from the SWR read — dim the panel but still show the
  // claim CTA so a signed-in user can retry.
  if (error) {
    return (
      <GlowCard className="p-5 mb-6">
        <div className="flex items-start gap-4">
          <IconBox>
            <ShieldCheck className="h-5 w-5 text-primary" />
          </IconBox>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground mb-1">
              Operator claims
            </h3>
            <p className="text-sm text-destructive">
              Couldn't load operator claims: {friendlyError(error)}
            </p>
          </div>
        </div>
      </GlowCard>
    );
  }

  if (isLoading || !data) {
    return (
      <GlowCard className="p-5 mb-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading operator claims...
        </div>
      </GlowCard>
    );
  }

  const hasAny = visibleOperators.length > 0;

  return (
    <GlowCard className="p-5 mb-6">
      <div className="flex items-start gap-4">
        <IconBox>
          <ShieldCheck className="h-5 w-5 text-primary" />
        </IconBox>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between mb-2 gap-2">
            <h3 className="font-semibold text-foreground">
              {hasAny ? 'Verified operators' : 'Operator claims'}
            </h3>
            {hasAny && (
              <span className="text-xs text-muted-foreground">
                {visibleOperators.length}{' '}
                {visibleOperators.length === 1 ? 'operator' : 'operators'}
              </span>
            )}
          </div>

          {hasAny ? (
            <ul className="space-y-2 mb-4">
              {visibleOperators.map((op) => (
                <OperatorEntry
                  key={op.account_id}
                  op={op}
                  isViewer={op.account_id === signedAccountId}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground mb-4">
              No human has signed a NEP-413 claim on this agent yet. Anyone with
              a NEAR wallet can file one to publicly attest that they operate
              this agent.
            </p>
          )}

          <ClaimAction
            isSignedIn={isSignedIn}
            walletLoading={walletLoading}
            signedAccountId={signedAccountId}
            viewerHasClaimed={viewerHasClaimed}
            writeState={writeState}
            onClaim={() => runClaim('claim')}
            onUnclaim={() => runClaim('unclaim')}
          />
        </div>
      </div>
    </GlowCard>
  );
}

function OperatorEntry({
  op,
  isViewer,
}: {
  op: OperatorClaimEntry;
  isViewer: boolean;
}) {
  const when =
    op.at !== undefined
      ? new Date(toMs(op.at)).toLocaleDateString()
      : undefined;

  return (
    <li className="flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/30">
      <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium text-foreground break-all">
            {op.account_id}
          </span>
          {isViewer && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-wide">
              you
            </span>
          )}
        </div>
        {op.name && <p className="text-xs text-muted-foreground">{op.name}</p>}
        {op.reason && (
          <p className="text-xs text-muted-foreground italic mt-1">
            "{op.reason}"
          </p>
        )}
        {when && (
          <p className="text-[11px] text-muted-foreground/70 mt-1">
            Claimed {when}
          </p>
        )}
      </div>
    </li>
  );
}

interface ClaimActionProps {
  isSignedIn: boolean;
  walletLoading: boolean;
  signedAccountId: string;
  viewerHasClaimed: boolean;
  writeState:
    | { status: 'idle' }
    | { status: 'signing' }
    | { status: 'writing'; action: 'claim' | 'unclaim' }
    | { status: 'error'; error: string };
  onClaim: () => void;
  onUnclaim: () => void;
}

function ClaimAction({
  isSignedIn,
  walletLoading,
  signedAccountId,
  viewerHasClaimed,
  writeState,
  onClaim,
  onUnclaim,
}: ClaimActionProps) {
  const busy =
    writeState.status === 'signing' || writeState.status === 'writing';

  if (walletLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading wallet...
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <>
        <Button
          type="button"
          onClick={onClaim}
          className="rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
        >
          <UserPlus className="h-4 w-4 mr-2" />
          Sign in to claim this agent
        </Button>
        <p className="text-[11px] text-muted-foreground mt-2">
          Connects your NEAR wallet and files a signed claim — no gas, no
          transaction, no stored session.
        </p>
      </>
    );
  }

  if (viewerHasClaimed) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={onUnclaim}
          disabled={busy}
          className="rounded-xl"
        >
          {writeState.status === 'signing' && (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Signing retraction...
            </>
          )}
          {writeState.status === 'writing' &&
            writeState.action === 'unclaim' && (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Removing claim...
              </>
            )}
          {(writeState.status === 'idle' ||
            writeState.status === 'error' ||
            (writeState.status === 'writing' &&
              writeState.action !== 'unclaim')) && (
            <>
              <X className="h-4 w-4 mr-2" />
              Remove my claim
            </>
          )}
        </Button>
        {writeState.status === 'error' && (
          <p className="text-xs text-destructive mt-2 break-words">
            {writeState.error}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <Button
        type="button"
        onClick={onClaim}
        disabled={busy}
        className="rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        {writeState.status === 'signing' && (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Signing claim...
          </>
        )}
        {writeState.status === 'writing' && writeState.action === 'claim' && (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Writing claim...
          </>
        )}
        {(writeState.status === 'idle' ||
          writeState.status === 'error' ||
          (writeState.status === 'writing' &&
            writeState.action !== 'claim')) && (
          <>
            <UserPlus className="h-4 w-4 mr-2" />
            Claim this agent
          </>
        )}
      </Button>
      <p className="text-[11px] text-muted-foreground mt-2">
        Signed in as{' '}
        <span className="font-mono text-foreground/80">{signedAccountId}</span>
      </p>
      {writeState.status === 'error' && (
        <p className="text-xs text-destructive mt-2 break-words">
          {writeState.error}
        </p>
      )}
    </>
  );
}
