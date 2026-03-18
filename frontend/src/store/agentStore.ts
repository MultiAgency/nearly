import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { MarketRegisterResponse } from '@/lib/market';
import type {
  OutlayerRegisterResponse,
  SignMessageResponse,
} from '@/lib/outlayer';

type StepNumber = 1 | 2 | 3;
type StepStatus = 'idle' | 'loading' | 'success' | 'error';

/** Explicit step status map — prevents accessing invalid step numbers */
type StepStatusMap = { 1: StepStatus; 2: StepStatus; 3: StepStatus };
type StepErrorMap = { 1: string | null; 2: string | null; 3: string | null };

/** Branded type to prevent accidentally swapping OutLayer and Market API keys */
type OutlayerApiKey = string & { readonly __brand?: 'OutlayerApiKey' };
/** Branded type to prevent accidentally swapping Market and OutLayer API keys */
type MarketApiKey = string & { readonly __brand?: 'MarketApiKey' };

interface AgentStore {
  // Step 1
  outlayerApiKey: OutlayerApiKey | null;
  nearAccountId: string | null;
  handoffUrl: string | null;

  // Step 2
  signResult: SignMessageResponse | null;
  signMessage: string | null;

  // Step 3
  marketAgentId: string | null;
  marketApiKey: MarketApiKey | null;
  marketHandle: string | null;

  // Step state
  currentStep: StepNumber;
  stepStatus: StepStatusMap;
  stepErrors: StepErrorMap;

  // Live API toggle
  useLiveApi: boolean;
  setUseLiveApi: (val: boolean) => void;

  // Manual API key entry
  setMarketApiKey: (key: string) => void;

  // Actions
  setStepLoading: (step: StepNumber) => void;
  setStepError: (step: StepNumber, error: string) => void;
  completeStep1: (data: OutlayerRegisterResponse) => void;
  completeStep2: (data: SignMessageResponse, message: string) => void;
  completeStep3: (data: MarketRegisterResponse) => void;
  reset: () => void;
}

const initialState = {
  outlayerApiKey: null as OutlayerApiKey | null,
  nearAccountId: null as string | null,
  handoffUrl: null as string | null,
  signResult: null as SignMessageResponse | null,
  signMessage: null as string | null,
  marketAgentId: null as string | null,
  marketApiKey: null as MarketApiKey | null,
  marketHandle: null as string | null,
  currentStep: 1 as const satisfies StepNumber,
  stepStatus: {
    1: 'idle',
    2: 'idle',
    3: 'idle',
  } as const satisfies StepStatusMap,
  stepErrors: { 1: null, 2: null, 3: null } satisfies StepErrorMap,
  useLiveApi: false,
};

export const useAgentStore = create<AgentStore>()(
  persist(
    (set) => ({
      ...initialState,

      setMarketApiKey: (key) => set({ marketApiKey: key as MarketApiKey }),

      setUseLiveApi: (val) =>
        set((s) => ({
          useLiveApi: val,
          // Reset Step 3 so user can re-register in the other mode
          marketAgentId: null,
          marketApiKey: null,
          marketHandle: null,
          stepStatus: { ...s.stepStatus, 3: 'idle' as const },
          stepErrors: { ...s.stepErrors, 3: null },
        })),

      setStepLoading: (step) =>
        set((s) => ({
          stepStatus: { ...s.stepStatus, [step]: 'loading' as const },
          stepErrors: { ...s.stepErrors, [step]: null },
        })),

      setStepError: (step, error) =>
        set((s) => ({
          stepStatus: { ...s.stepStatus, [step]: 'error' as const },
          stepErrors: { ...s.stepErrors, [step]: error },
        })),

      completeStep1: (data) =>
        set((s) => ({
          outlayerApiKey: data.api_key as OutlayerApiKey,
          nearAccountId: data.near_account_id,
          handoffUrl: data.handoff_url,
          currentStep: 2 as const,
          stepStatus: { ...s.stepStatus, 1: 'success' as const },
        })),

      completeStep2: (data, message) =>
        set((s) => ({
          signResult: data,
          signMessage: message,
          currentStep: 3 as const,
          stepStatus: { ...s.stepStatus, 2: 'success' as const },
        })),

      completeStep3: (data) =>
        set((s) => ({
          marketAgentId: data.agent_id,
          marketApiKey: data.api_key as MarketApiKey,
          marketHandle: data.handle,
          stepStatus: { ...s.stepStatus, 3: 'success' as const },
        })),

      reset: () => set(initialState),
    }),
    {
      name: 'near-agency-agent',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
