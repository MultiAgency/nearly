import { create } from 'zustand';
import type { OutlayerRegisterResponse } from '@/lib/outlayer';
import type { HeartbeatResponse, StepStatus } from '@/types';

type OnboardPath = 'new' | 'byo' | 'external-near';
type StepNumber = 1 | 2;

interface AgentStore {
  /** Which onboarding path the user chose. Null until they pick. */
  path: OnboardPath | null;

  apiKey: string | null;
  accountId: string | null;
  /** OutLayer `/register`'s `handoff_url`, null for BYO or when omitted. */
  handoffUrl: string | null;

  /** Steps only apply to the "new" path (create wallet → fund). */
  stepStatus: Record<StepNumber, StepStatus>;
  stepErrors: Record<StepNumber, string | null>;

  /** BYO wallet verification status. */
  byoStatus: StepStatus;
  byoError: string | null;

  /**
   * External-NEAR (deterministic) path. Caller supplies their own NEAR
   * account + ed25519 key; signing happens in the browser; OutLayer
   * returns a derived wallet (`walletId` + hex64 `nearAccountId`).
   *
   * When the user opts into delegate-key minting (default), the flow
   * also mints a session-scoped `wk_` via `PUT /wallet/v1/api-key` and
   * activates it on the `ApiClient` singleton — the user gets a working
   * agent in one step. The `wk_` is never persisted to browser storage;
   * page reload re-derives it by re-running the flow with the same
   * inputs.
   *
   * When the user opts out (`--no-mint-key` equivalent), only
   * provisioning runs and `externalNearWalletKey` stays null — matches
   * the second-reopen "manage externally" shape.
   */
  externalNearStatus: StepStatus;
  externalNearError: string | null;
  externalNearWalletId: string | null;
  externalNearNearAccountId: string | null;
  /** Minted delegate `wk_`, session-scoped. Null in provisioning-only mode. */
  externalNearWalletKey: string | null;

  /** Heartbeat lifecycle — shared by both paths. */
  heartbeatStatus: StepStatus;
  heartbeatError: string | null;
  heartbeatData: HeartbeatResponse | null;
  /** True when the user chose "Hand off to my agent" instead of activating. */
  skippedHeartbeat: boolean;

  choosePath: (path: OnboardPath) => void;

  // "new" path
  setStepLoading: (step: StepNumber) => void;
  setStepError: (step: StepNumber, error: string) => void;
  completeStep1: (data: OutlayerRegisterResponse) => void;
  completeStep2: () => void;

  // "byo" path
  setByoLoading: () => void;
  setByoError: (error: string) => void;
  completeByo: (apiKey: string, accountId: string) => void;

  // "external-near" path
  setExternalNearLoading: () => void;
  setExternalNearError: (error: string) => void;
  completeExternalNear: (
    walletId: string,
    nearAccountId: string,
    walletKey?: string | null,
  ) => void;

  // post-funding (both paths)
  setHeartbeatLoading: () => void;
  setHeartbeatError: (error: string) => void;
  setHeartbeatSuccess: (data: HeartbeatResponse) => void;
  skipHeartbeat: () => void;

  reset: () => void;
}

const initialState = {
  path: null as OnboardPath | null,
  apiKey: null as string | null,
  accountId: null as string | null,
  handoffUrl: null as string | null,
  stepStatus: { 1: 'idle', 2: 'idle' } as Record<StepNumber, StepStatus>,
  stepErrors: { 1: null, 2: null } as Record<StepNumber, string | null>,
  byoStatus: 'idle' as StepStatus,
  byoError: null as string | null,
  externalNearStatus: 'idle' as StepStatus,
  externalNearError: null as string | null,
  externalNearWalletId: null as string | null,
  externalNearNearAccountId: null as string | null,
  externalNearWalletKey: null as string | null,
  heartbeatStatus: 'idle' as StepStatus,
  heartbeatError: null as string | null,
  heartbeatData: null as HeartbeatResponse | null,
  skippedHeartbeat: false,
};

export const useAgentStore = create<AgentStore>()((set) => {
  const updateStep = (
    step: StepNumber,
    status: StepStatus,
    error: string | null = null,
  ) =>
    set((s) => ({
      stepStatus: { ...s.stepStatus, [step]: status },
      stepErrors: { ...s.stepErrors, [step]: error },
    }));

  const completeStep = (step: StepNumber, extra: Partial<AgentStore>) =>
    set((s) => ({
      stepStatus: { ...s.stepStatus, [step]: 'success' as const },
      stepErrors: { ...s.stepErrors, [step]: null },
      ...extra,
    }));

  return {
    ...initialState,

    choosePath: (path) => set({ path }),

    // "new" path
    setStepLoading: (step) => updateStep(step, 'loading'),
    setStepError: (step, error) => updateStep(step, 'error', error),

    completeStep1: (data) =>
      completeStep(1, {
        apiKey: data.api_key,
        accountId: data.near_account_id,
        handoffUrl: data.handoff_url ?? null,
      }),

    completeStep2: () => completeStep(2, {}),

    // "byo" path
    setByoLoading: () => set({ byoStatus: 'loading', byoError: null }),
    setByoError: (error) => set({ byoStatus: 'error', byoError: error }),
    completeByo: (apiKey, accountId) =>
      set({ byoStatus: 'success', byoError: null, apiKey, accountId }),

    // "external-near" path
    setExternalNearLoading: () =>
      set({ externalNearStatus: 'loading', externalNearError: null }),
    setExternalNearError: (error) =>
      set({ externalNearStatus: 'error', externalNearError: error }),
    completeExternalNear: (walletId, nearAccountId, walletKey = null) =>
      set({
        externalNearStatus: 'success',
        externalNearError: null,
        externalNearWalletId: walletId,
        externalNearNearAccountId: nearAccountId,
        externalNearWalletKey: walletKey,
        // When a delegate wk_ was minted, also populate the shared
        // apiKey/accountId fields so the post-funding heartbeat flow
        // (shared with new/byo paths) can use the same credentials.
        ...(walletKey ? { apiKey: walletKey, accountId: nearAccountId } : {}),
      }),

    // post-funding (both paths)
    setHeartbeatLoading: () =>
      set({ heartbeatStatus: 'loading', heartbeatError: null }),

    setHeartbeatError: (error) =>
      set({ heartbeatStatus: 'error', heartbeatError: error }),

    setHeartbeatSuccess: (data) =>
      set({
        heartbeatStatus: 'success',
        heartbeatError: null,
        heartbeatData: data,
      }),

    skipHeartbeat: () => set({ skippedHeartbeat: true }),

    reset: () => set(initialState),
  };
});
