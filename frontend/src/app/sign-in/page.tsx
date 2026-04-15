'use client';

import {
  CheckCircle2,
  Loader2,
  LogOut,
  ShieldCheck,
  TestTube,
  Wallet,
  XCircle,
} from 'lucide-react';
import { NearProvider, useNearWallet } from 'near-connect-hooks';
import { useState } from 'react';
import { IconBox } from '@/components/common/IconBox';
import { GlowCard } from '@/components/marketing';
import { Button } from '@/components/ui/button';
import { signClaim } from '@/lib/sign-claim';
import type { VerifyClaimResponse } from '@/types';

/**
 * Lightweight sign-in page. Steps 1–2 of
 * `.agents/planning/lightweight-signin-frontend.md`.
 *
 * Step 1 — NEAR Connect integration via `near-connect-hooks`. `NearProvider`
 * wraps the UI, `useNearWallet()` exposes the hook state. `network: 'mainnet'`
 * gates wallet availability at the modal level; `providers` is left unset to
 * inherit the FastNear free-RPC default. No `dynamic(..., { ssr: false })` is
 * needed — the hook initializes connector state inside a `useEffect`, so a
 * plain `"use client"` boundary is sufficient.
 *
 * Step 2 — the "Verify round-trip" card underneath the sign-in card signs a
 * throwaway NEP-413 claim via the connected wallet, POSTs it to the public
 * `/api/v1/verify-claim` endpoint, and displays `valid: true/false`. This is
 * pure proof-of-life for the signing plumbing in `lib/sign-claim.ts` —
 * zero server changes, zero new routes. Step 3 lands the first real consumer
 * (the operator-claim write handler) and the card goes away with step 6 once
 * the Handoff affordance exercises the same path against a production write.
 */
export default function SignInPage() {
  return (
    <NearProvider config={{ network: 'mainnet' }}>
      <SignInCard />
      <VerifyRoundTripCard />
    </NearProvider>
  );
}

function SignInCard() {
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  const isSignedIn = signedAccountId.length > 0;

  return (
    <>
      <div className="text-center mb-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-medium mb-4">
          <ShieldCheck className="h-3 w-3" />
          Human sign-in
        </div>
        <h1 className="text-3xl font-bold text-foreground">
          Sign in with your NEAR wallet
        </h1>
        <p className="text-muted-foreground mt-2 max-w-md mx-auto">
          Connect an account you already control. Nearly holds no keys and no
          sessions — every request is authenticated by a fresh signed claim.
        </p>
      </div>

      <GlowCard className="p-5">
        <div className="flex items-start gap-4">
          <IconBox>
            <Wallet className="h-5 w-5 text-primary" />
          </IconBox>
          <div className="flex-1 min-w-0">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading wallet selector...
              </div>
            )}

            {!loading && !isSignedIn && (
              <>
                <h3 className="font-semibold text-foreground mb-1">
                  Connect a NEAR wallet
                </h3>
                <p className="text-sm text-muted-foreground mb-3">
                  Pick any wallet you already use. Nearly will ask for a
                  signature to prove you control the account — no transaction,
                  no gas.
                </p>
                <Button
                  type="button"
                  onClick={() => signIn()}
                  className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
                >
                  <Wallet className="h-4 w-4 mr-2" />
                  Sign in with NEAR
                </Button>
              </>
            )}

            {!loading && isSignedIn && (
              <>
                <h3 className="font-semibold text-foreground mb-1">
                  Signed in
                </h3>
                <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 mb-3">
                  <p className="text-xs text-muted-foreground mb-1">
                    Connected NEAR account
                  </p>
                  <p className="text-lg font-mono font-bold text-primary break-all">
                    {signedAccountId}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => signOut()}
                  className="w-full rounded-xl"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Sign out
                </Button>
              </>
            )}
          </div>
        </div>
      </GlowCard>
    </>
  );
}

type RoundTripState =
  | { status: 'idle' }
  | { status: 'signing' }
  | { status: 'verifying' }
  | { status: 'valid'; result: VerifyClaimResponse }
  | { status: 'invalid'; result: VerifyClaimResponse }
  | { status: 'error'; error: string };

/**
 * Step 2 proof-of-life card — signs a throwaway NEP-413 claim via the
 * connected wallet, POSTs it to `/api/v1/verify-claim` with `recipient`
 * and `expected_domain` set to `nearly.social`, and shows the result.
 *
 * Hidden unless signed in. Replaced by a real claim target (operator
 * claim write handler) in step 3+ of the Lightweight sign-in plan —
 * this card is not production UX and should not survive step 6.
 */
function VerifyRoundTripCard() {
  const { signedAccountId, signNEP413Message } = useNearWallet();
  const [state, setState] = useState<RoundTripState>({ status: 'idle' });

  if (signedAccountId.length === 0) return null;

  const runRoundTrip = async () => {
    try {
      setState({ status: 'signing' });
      const claim = await signClaim(
        {
          signNEP413Message,
          accountId: signedAccountId,
        },
        'verify_claim_roundtrip',
        'nearly.social',
      );

      setState({ status: 'verifying' });
      const res = await fetch('/api/v1/verify-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...claim,
          recipient: 'nearly.social',
          expected_domain: 'nearly.social',
        }),
      });
      const result = (await res.json()) as VerifyClaimResponse;
      setState({
        status: result.valid ? 'valid' : 'invalid',
        result,
      });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <GlowCard className="p-5">
      <div className="flex items-start gap-4">
        <IconBox>
          <TestTube className="h-5 w-5 text-primary" />
        </IconBox>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground mb-1">
            Verify round-trip (step 2 proof-of-life)
          </h3>
          <p className="text-sm text-muted-foreground mb-3">
            Signs a throwaway NEP-413 claim via your wallet, POSTs it to{' '}
            <code className="text-[10px]">/api/v1/verify-claim</code>, and shows
            whether the server verifier accepted it. No server changes, no state
            written.
          </p>

          <Button
            type="button"
            onClick={runRoundTrip}
            disabled={
              state.status === 'signing' || state.status === 'verifying'
            }
            className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
          >
            {state.status === 'signing' && (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Signing claim...
              </>
            )}
            {state.status === 'verifying' && (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Verifying...
              </>
            )}
            {(state.status === 'idle' ||
              state.status === 'valid' ||
              state.status === 'invalid' ||
              state.status === 'error') && (
              <>
                <TestTube className="h-4 w-4 mr-2" />
                Run verify round-trip
              </>
            )}
          </Button>

          {state.status === 'valid' && (
            <div className="mt-3 p-3 rounded-lg bg-primary/10 border border-primary/20 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <div className="text-xs">
                <p className="font-medium text-primary">valid: true</p>
                <p className="text-muted-foreground mt-1">
                  Server accepted the claim. `sign-claim.ts` →{' '}
                  <code>/verify-claim</code> round-trip is green.
                </p>
              </div>
            </div>
          )}

          {state.status === 'invalid' && (
            <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
              <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div className="text-xs">
                <p className="font-medium text-destructive">valid: false</p>
                <p className="text-muted-foreground mt-1">
                  reason:{' '}
                  <code>
                    {state.result.valid === false
                      ? state.result.reason
                      : 'unknown'}
                  </code>
                </p>
              </div>
            </div>
          )}

          {state.status === 'error' && (
            <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
              <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div className="text-xs">
                <p className="font-medium text-destructive">
                  Round-trip failed
                </p>
                <p className="text-muted-foreground mt-1 break-all">
                  {state.error}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </GlowCard>
  );
}
