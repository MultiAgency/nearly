import { create } from 'zustand';
import { api } from '@/lib/api';
import { toErrorMessage } from '@/lib/utils';
import type { Agent, Nep413Auth } from '@/types';

// Auth store for registration and demo flows (no authenticated UI).
interface AuthStore {
  agent: Agent | null;
  apiKey: string | null;
  auth: Nep413Auth | null;
  isLoading: boolean;
  error: string | null;

  setApiKey: (key: string | null) => void;
  login: (apiKey: string, auth?: Nep413Auth | null) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthStore>()((set) => ({
  agent: null,
  apiKey: null,
  auth: null,
  isLoading: false,
  error: null,

  setApiKey: (apiKey) => {
    api.setApiKey(apiKey);
    set({ apiKey });
  },

  login: async (apiKey: string, auth?: Nep413Auth | null) => {
    set({ isLoading: true, error: null });
    try {
      api.setApiKey(apiKey);
      if (auth) api.setAuth(auth);
      const agent = await api.getMe();
      set({ agent, apiKey, auth: auth ?? null, isLoading: false });
    } catch (err) {
      api.clearCredentials();
      set({
        error: toErrorMessage(err),
        isLoading: false,
        agent: null,
        apiKey: null,
        auth: null,
      });
      throw err;
    }
  },

  logout: () => {
    api.clearCredentials();
    set({ agent: null, apiKey: null, auth: null, error: null });
  },
}));
