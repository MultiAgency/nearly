import { useAuthStore } from '@/store';
import { api } from '@/lib/api';
import { TEST_AUTH, resetStores } from './fixtures';

jest.mock('@/lib/api', () => ({
  api: {
    setApiKey: jest.fn(),
    setAuth: jest.fn(),
    clearCredentials: jest.fn(),
    getMe: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
});

describe('useAuthStore', () => {
  describe('setApiKey', () => {
    it('sets the apiKey and calls api.setApiKey', () => {
      useAuthStore.getState().setApiKey('wk_abc');
      expect(useAuthStore.getState().apiKey).toBe('wk_abc');
      expect(mockApi.setApiKey).toHaveBeenCalledWith('wk_abc');
    });
  });

  describe('login', () => {
    it('succeeds: sets agent, apiKey, clears loading', async () => {
      const agent = { handle: 'bot', follower_count: 0, following_count: 0, created_at: 1 };
      mockApi.getMe.mockResolvedValue(agent as any);

      await useAuthStore.getState().login('wk_key123');

      const state = useAuthStore.getState();
      expect(state.agent).toEqual(agent);
      expect(state.apiKey).toBe('wk_key123');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(mockApi.setApiKey).toHaveBeenCalledWith('wk_key123');
    });

    it('succeeds with auth: sets auth on api client', async () => {
      mockApi.getMe.mockResolvedValue({ handle: 'bot' } as any);

      await useAuthStore.getState().login('wk_key', TEST_AUTH);

      expect(mockApi.setAuth).toHaveBeenCalledWith(TEST_AUTH);
      expect(useAuthStore.getState().auth).toEqual(TEST_AUTH);
    });

    it('failure: clears credentials and sets error', async () => {
      mockApi.getMe.mockRejectedValue(new Error('Bad key'));

      await expect(useAuthStore.getState().login('wk_bad')).rejects.toThrow('Bad key');

      const state = useAuthStore.getState();
      expect(state.agent).toBeNull();
      expect(state.apiKey).toBeNull();
      expect(state.auth).toBeNull();
      expect(state.error).toBe('Bad key');
      expect(state.isLoading).toBe(false);
      expect(mockApi.clearCredentials).toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('clears everything', () => {
      useAuthStore.setState({
        agent: { handle: 'bot' } as any,
        apiKey: 'wk_key',
        auth: { near_account_id: 'a.near' } as any,
        error: 'old error',
      });

      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.agent).toBeNull();
      expect(state.apiKey).toBeNull();
      expect(state.auth).toBeNull();
      expect(state.error).toBeNull();
      expect(mockApi.clearCredentials).toHaveBeenCalled();
    });
  });
});
