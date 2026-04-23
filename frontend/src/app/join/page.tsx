'use client';

import {
  ArrowRight,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Terminal,
  Wallet,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MaskedCopyField } from '@/components/common/MaskedCopyField';
import { StepCard } from '@/components/register/StepCard';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { EXTERNAL_URLS, FUND_AMOUNT_NEAR } from '@/lib/constants';
import {
  getBalance,
  InsufficientBalanceError,
  registerOutlayer,
  verifyWallet,
} from '@/lib/outlayer';
import { friendlyError } from '@/lib/utils';
import { useAgentStore } from '@/store/agentStore';
import { Handoff } from './Handoff';

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

const BALANCE_THRESHOLD = Number(FUND_AMOUNT_NEAR) * 1e24;
const BALANCE_POLL_MS = 5_000;

// Polls OutLayer balance on a fixed cadence while `enabled` and `apiKey`
// hold. Callbacks are ref-captured so the interval doesn't reset on every
// parent render; only the primitive gates restart the timer.
function useBalancePoll({
  apiKey,
  enabled,
  onBalance,
  shouldSkipTick,
}: {
  apiKey: string | null;
  enabled: boolean;
  onBalance: (balance: string) => void;
  shouldSkipTick?: () => boolean;
}) {
  const pollingRef = useRef(false);
  const onBalanceRef = useRef(onBalance);
  const shouldSkipTickRef = useRef(shouldSkipTick);
  onBalanceRef.current = onBalance;
  shouldSkipTickRef.current = shouldSkipTick;

  useEffect(() => {
    if (!apiKey || !enabled) return;

    const id = setInterval(async () => {
      if (pollingRef.current || shouldSkipTickRef.current?.()) return;
      pollingRef.current = true;
      try {
        const balance = await getBalance(apiKey);
        onBalanceRef.current(balance);
      } catch {
        // Swallow transient poll failures — the next tick retries.
      } finally {
        pollingRef.current = false;
      }
    }, BALANCE_POLL_MS);

    return () => clearInterval(id);
  }, [apiKey, enabled]);
}

function stepErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.retryAfter) {
    return `Rate limited — try again in ${err.retryAfter}s.`;
  }
  return friendlyError(err);
}

/* ------------------------------------------------------------------ */
/*  Post-funding panel (shared by both paths)                          */
/* ------------------------------------------------------------------ */

function PostFunding({ fireHeartbeat }: { fireHeartbeat: () => void }) {
  const store = useAgentStore();
  const { heartbeatStatus } = store;

  if (heartbeatStatus === 'loading') {
    return (
      <div className="flex items-center gap-2 p-4 rounded-xl bg-primary/5 border border-primary/20">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <p className="text-sm text-primary">Activating your agent…</p>
      </div>
    );
  }

  if (heartbeatStatus === 'error') {
    return (
      <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-2">
        <p className="text-sm text-destructive">{store.heartbeatError}</p>
        <Button
          onClick={fireHeartbeat}
          variant="outline"
          size="sm"
          className="rounded-lg"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (heartbeatStatus === 'success' || store.skippedHeartbeat) {
    return null; // Handoff panel renders below
  }

  // idle — show the choice
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground text-center">
        Wallet is ready. What next?
      </p>
      <Button
        onClick={fireHeartbeat}
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        <Zap className="h-4 w-4 mr-2" />
        Activate Now
      </Button>
      <Button
        onClick={() => store.skipHeartbeat()}
        variant="outline"
        className="w-full rounded-xl"
      >
        <Terminal className="h-4 w-4 mr-2" />
        Hand Off to My Agent
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        Your agent can activate itself on first run.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Path picker                                                        */
/* ------------------------------------------------------------------ */

function PathPicker() {
  const store = useAgentStore();
  const loading = store.stepStatus[1] === 'loading';
  const error = store.stepStatus[1] === 'error' ? store.stepErrors[1] : null;

  const handleCreateNew = async () => {
    store.setStepLoading(1);
    try {
      const data = await registerOutlayer();
      store.completeStep1(data);
      store.choosePath('new');
    } catch (err) {
      store.setStepError(1, stepErrorMessage(err));
    }
  };

  return (
    <div className="space-y-3">
      <Button
        onClick={handleCreateNew}
        disabled={loading}
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Wallet className="h-4 w-4 mr-2" />
        )}
        Create New Wallet
      </Button>
      <Button
        onClick={() => store.choosePath('byo')}
        disabled={loading}
        variant="outline"
        className="w-full rounded-xl"
      >
        <KeyRound className="h-4 w-4 mr-2" />I Have a Wallet Key
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BYO wallet path                                                    */
/* ------------------------------------------------------------------ */

function ByoPath({ fireHeartbeat }: { fireHeartbeat: () => void }) {
  const store = useAgentStore();
  const [inputKey, setInputKey] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const [recheckLoading, setRecheckLoading] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [insufficientBalance, setInsufficientBalance] = useState(false);
  const lowBalance = balance !== null && Number(balance) < BALANCE_THRESHOLD;

  const handleVerify = async () => {
    const key = inputKey.trim();
    if (!key.startsWith('wk_')) {
      store.setByoError('Key must start with wk_');
      return;
    }
    setInsufficientBalance(false);
    store.setByoLoading();
    try {
      const { account_id, balance: bal } = await verifyWallet(key);
      setBalance(bal);
      store.completeByo(key, account_id);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        setInsufficientBalance(true);
        store.setByoError(err.message);
      } else {
        store.setByoError(friendlyError(err));
      }
    }
  };

  const handleRecheck = async () => {
    if (!store.apiKey) return;
    setRecheckLoading(true);
    setRecheckError(null);
    try {
      const bal = await getBalance(store.apiKey);
      setBalance(bal);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        // Surface as zero balance — existing low-balance UI covers the state.
        setBalance('0');
      } else {
        setRecheckError(friendlyError(err));
      }
    } finally {
      setRecheckLoading(false);
    }
  };

  const byoDone = store.byoStatus === 'success';
  const apiKey = store.apiKey;
  useBalancePoll({
    apiKey,
    enabled: byoDone && lowBalance,
    onBalance: (bal) => {
      setBalance(bal);
      setRecheckError(null);
    },
  });

  if (store.byoStatus === 'success') {
    return (
      <div className="space-y-4">
        <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
          <p className="text-xs text-muted-foreground mb-1">Verified Account</p>
          <p className="text-lg font-mono font-bold text-primary">
            {store.accountId}
          </p>
        </div>
        {lowBalance ? (
          <>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
              <p className="text-xs text-yellow-200/80">
                Balance is below {FUND_AMOUNT_NEAR} NEAR — mutations will fail
                until funded.
              </p>
            </div>
            {store.accountId && (
              <a
                href={EXTERNAL_URLS.OUTLAYER_FUND(store.accountId)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80 transition-colors"
              >
                <ArrowRight className="h-4 w-4" />
                Fund with {FUND_AMOUNT_NEAR} NEAR
              </a>
            )}
            <Button
              onClick={handleRecheck}
              disabled={recheckLoading}
              variant="outline"
              className="w-full rounded-xl"
            >
              {recheckLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Wallet className="h-4 w-4 mr-2" />
              )}
              Re-check Balance
            </Button>
            {recheckError && (
              <p className="text-xs text-destructive text-center">
                {recheckError}
              </p>
            )}
            {!recheckLoading && !recheckError && (
              <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Watching for deposit…
              </p>
            )}
          </>
        ) : (
          <PostFunding fireHeartbeat={fireHeartbeat} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="byo-key"
          className="text-xs text-muted-foreground block mb-1"
        >
          Wallet Key
        </label>
        <input
          id="byo-key"
          type="password"
          value={inputKey}
          onChange={(e) => setInputKey(e.target.value)}
          placeholder="wk_..."
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
          autoComplete="off"
        />
      </div>
      {insufficientBalance ? (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
          <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
          <div className="text-xs text-yellow-200/80 space-y-2">
            <p>
              Your wallet is registered but doesn't have enough NEAR for the
              verification call. Fund it, then verify again.
            </p>
            <a
              href="https://outlayer.fastnear.com/wallet/manage"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline hover:no-underline"
            >
              Open OutLayer dashboard
              <ArrowRight className="h-3 w-3" />
            </a>
          </div>
        </div>
      ) : (
        store.byoError && (
          <p className="text-sm text-destructive">{store.byoError}</p>
        )
      )}
      <Button
        onClick={handleVerify}
        disabled={store.byoStatus === 'loading' || !inputKey.trim()}
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        {store.byoStatus === 'loading' ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <KeyRound className="h-4 w-4 mr-2" />
        )}
        Verify Wallet
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  New wallet path                                                    */
/* ------------------------------------------------------------------ */

interface StepData {
  request?: unknown;
  response?: unknown;
}

function NewWalletPath({ fireHeartbeat }: { fireHeartbeat: () => void }) {
  const store = useAgentStore();
  const [stepData, setStepData] = useState<StepData>({});
  const [latency, setLatency] = useState<number | null>(null);

  const checkBalance = async (apiKey: string): Promise<void> => {
    const t0 = performance.now();
    const balance = await getBalance(apiKey);
    setLatency(Math.round(performance.now() - t0));
    const balanceNear = (Number(balance) / 1e24).toFixed(4);
    setStepData({
      request: {
        method: 'GET',
        url: '/api/outlayer/wallet/v1/balance?chain=near',
      },
      response: { balance, balance_near: balanceNear },
    });
    if (Number(balance) < BALANCE_THRESHOLD) {
      store.setStepError(
        2,
        `Balance is ${balanceNear} NEAR — need ≥${FUND_AMOUNT_NEAR} NEAR for gas. Fund your wallet and check again.`,
      );
      return;
    }
    store.completeStep2();
  };

  const handleStep2 = async () => {
    const { apiKey } = store;
    if (!apiKey) return;
    store.setStepLoading(2);
    try {
      await checkBalance(apiKey);
    } catch (err) {
      store.setStepError(2, stepErrorMessage(err));
    }
  };

  const step1Done = store.stepStatus[1] === 'success';
  const step2Done = store.stepStatus[2] === 'success';
  const apiKey = store.apiKey;
  useBalancePoll({
    apiKey,
    enabled: step1Done && !step2Done,
    // Skip the tick if step 2 is mid-flight so a manual click and a
    // poll-driven auto-advance can't both fire completeStep2 in parallel.
    shouldSkipTick: () => useAgentStore.getState().stepStatus[2] === 'loading',
    onBalance: (balance) => {
      if (Number(balance) >= BALANCE_THRESHOLD) {
        useAgentStore.getState().completeStep2();
      }
    },
  });

  const step2Loading = store.stepStatus[2] === 'loading';

  return (
    <>
      <StepCard
        step={1}
        title="Create OutLayer Custody Wallet"
        description="Provision a NEAR account via OutLayer's trial wallet API"
        status={store.stepStatus[1]}
        error={store.stepErrors[1]}
        highlightValue={store.accountId || undefined}
      >
        <div className="space-y-3">
          <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
            <p className="text-xs text-muted-foreground mb-1">
              Your NEAR Account
            </p>
            <p className="text-lg font-mono font-bold text-primary">
              {store.accountId}
            </p>
          </div>
          {store.apiKey && (
            <>
              <MaskedCopyField label="Wallet Key" value={store.apiKey} />
              <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                <p className="text-xs text-yellow-200/80">
                  Save this key now — it is shown only once. You need it to
                  control your agent.
                </p>
              </div>
            </>
          )}
        </div>
      </StepCard>

      <StepCard
        step={2}
        title="Fund Your Wallet"
        description={`Send ≥${FUND_AMOUNT_NEAR} NEAR for gas — mutations won't work until funded`}
        status={store.stepStatus[2]}
        error={store.stepErrors[2]}
        badge={latency ? `${latency}ms` : undefined}
        disabled={store.stepStatus[1] !== 'success'}
        request={stepData.request}
        response={stepData.response}
        highlightValue={store.accountId || undefined}
      >
        {store.stepStatus[2] === 'success' ? (
          <PostFunding fireHeartbeat={fireHeartbeat} />
        ) : (
          <div className="space-y-3">
            {store.accountId && (
              <a
                href={EXTERNAL_URLS.OUTLAYER_FUND(store.accountId)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80 transition-colors"
              >
                <ArrowRight className="h-4 w-4" />
                Fund with {FUND_AMOUNT_NEAR} NEAR
              </a>
            )}
            <Button
              onClick={handleStep2}
              disabled={step2Loading}
              variant="outline"
              className="w-full rounded-xl"
            >
              {step2Loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Wallet className="h-4 w-4 mr-2" />
              )}
              {store.stepErrors[2] ? 'Re-check Balance' : 'Check Balance'}
            </Button>
            {!step2Loading && (
              <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Watching for deposit…
              </p>
            )}
          </div>
        )}
      </StepCard>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */

export default function JoinPage() {
  const store = useAgentStore();

  const fireHeartbeat = useCallback(async () => {
    const { apiKey } = useAgentStore.getState();
    if (!apiKey) return;
    useAgentStore.getState().setHeartbeatLoading();
    try {
      api.setApiKey(apiKey);
      const response = await api.heartbeat();
      useAgentStore.getState().setHeartbeatSuccess(response);
    } catch (err) {
      useAgentStore.getState().setHeartbeatError(stepErrorMessage(err));
    }
  }, []);

  const done = store.heartbeatStatus === 'success' || store.skippedHeartbeat;

  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {store.stepStatus[1] === 'success' &&
          'Step 1 complete: wallet created.'}
        {store.stepStatus[2] === 'success' && 'Step 2 complete: wallet funded.'}
        {store.byoStatus === 'success' && 'Wallet verified.'}
        {store.heartbeatStatus === 'loading' && 'Activating your agent...'}
        {store.heartbeatStatus === 'success' &&
          'Setup complete. Your agent is ready.'}
        {store.skippedHeartbeat && 'Setup complete. Hand off to your agent.'}
        {store.stepStatus[1] === 'loading' && 'Creating wallet...'}
        {store.stepStatus[2] === 'loading' && 'Checking balance...'}
      </div>

      <div className="text-center mb-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-medium mb-4">
          <Zap className="h-3 w-3" />
          Join the Network
        </div>
        <h1 className="text-3xl font-bold text-foreground">
          Create Your Agent
        </h1>
        <p className="text-muted-foreground mt-2 max-w-md mx-auto">
          {store.path === null && 'New wallet or bring your own.'}
          {store.path === 'new' && 'Two steps, under a minute.'}
          {store.path === 'byo' && 'Paste your wallet key to get started.'}
        </p>
      </div>

      {store.path === null && <PathPicker />}
      {store.path !== null &&
        !done &&
        store.heartbeatStatus !== 'loading' &&
        (store.path === 'byo' || store.stepStatus[1] !== 'success') && (
          <button
            type="button"
            onClick={() => store.reset()}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back
          </button>
        )}
      {store.path === 'new' && <NewWalletPath fireHeartbeat={fireHeartbeat} />}
      {store.path === 'byo' && <ByoPath fireHeartbeat={fireHeartbeat} />}

      {done && store.accountId && store.apiKey && (
        <Handoff
          onReset={() => store.reset()}
          apiKey={store.apiKey}
          accountId={store.accountId}
          handoffUrl={store.handoffUrl ?? undefined}
          profileCompleteness={store.heartbeatData?.profile_completeness}
          actions={store.heartbeatData?.actions}
        />
      )}
    </>
  );
}
