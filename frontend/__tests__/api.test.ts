import { api, ApiError } from '@/lib/api';
import { executeWasm, OutlayerExecError } from '@/lib/outlayer-exec';
import { TEST_AUTH } from './fixtures';

jest.mock('@/lib/outlayer-exec', () => {
  const actual = jest.requireActual('@/lib/outlayer-exec');
  return {
    ...actual,
    executeWasm: jest.fn(),
  };
});

const mockExecuteWasm = executeWasm as jest.MockedFunction<typeof executeWasm>;

beforeEach(() => {
  jest.clearAllMocks();
  api.clearCredentials();
});

describe('ApiClient', () => {
  describe('credentials management', () => {
    it('throws 401 when no API key is set for authenticated calls', async () => {
      await expect(api.getMe()).rejects.toMatchObject({ statusCode: 401 });
    });

    it('clears credentials so authenticated calls fail', async () => {
      api.setApiKey('wk_test');
      api.setAuth(TEST_AUTH);
      api.clearCredentials();
      await expect(api.getMe()).rejects.toMatchObject({ statusCode: 401 });
    });
  });

  describe('request without API key', () => {
    it('throws 401 for authenticated actions when no API key is set', async () => {
      await expect(api.getMe()).rejects.toThrow(ApiError);
      await expect(api.getMe()).rejects.toMatchObject({ statusCode: 401 });
    });

    it('routes public reads through /api/v1 REST endpoints when no API key is set', async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({ output: { success: true, data: [] } }),
        });

        const result = await api.listAgents(10);
        expect(result).toEqual({ agents: [] });

        // Verify it hit /api/v1 REST endpoint, not the OutLayer proxy
        const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
        expect(callUrl).toBe('/api/v1/agents?limit=10');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('successful requests', () => {
    beforeEach(() => {
      api.setApiKey('wk_test');
    });

    it('returns data from executeWasm', async () => {
      const agent = { handle: 'bot_1', follower_count: 0, following_count: 0, created_at: 1 };
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agent },
      });

      const result = await api.getMe();
      expect(result).toEqual(agent);
    });
  });

  describe('error mapping', () => {
    beforeEach(() => {
      api.setApiKey('wk_test');
    });

    it.each([
      ['unauthorized code maps to 401', 'Invalid auth token', 'unauthorized', 401],
      ['auth_required code maps to 401', 'Auth required', 'auth_required', 401],
      ['forbidden code maps to 403', 'Action forbidden', 'forbidden', 403],
      ['not_found code maps to 404', 'Agent not found', 'not_found', 404],
      ['unknown code maps to 400', 'Invalid input data', undefined, 400],
      ['no code maps to 400', 'Some error', undefined, 400],
    ])('%s', async (_label, message, code, expectedCode) => {
      const { OutlayerExecError: MockExecError } = jest.requireMock('@/lib/outlayer-exec');
      mockExecuteWasm.mockRejectedValue(new MockExecError(message, code));

      try {
        await api.getMe();
        throw new Error('Expected getMe to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).statusCode).toBe(expectedCode);
      }
    });

    it('passes through non-OutlayerExecError', async () => {
      const genericError = new TypeError('Network failure');
      mockExecuteWasm.mockRejectedValue(genericError);

      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBe(genericError);
      expect(err).not.toBeInstanceOf(ApiError);
    });
  });

  describe('request forwarding', () => {
    beforeEach(() => {
      api.setApiKey('wk_test');
      mockExecuteWasm.mockResolvedValue({ success: true, data: {} });
    });

    it('passes auth when set on client', async () => {
      api.setAuth(TEST_AUTH);
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agent: { handle: 'me' } },
      });
      await api.getMe();
      expect(mockExecuteWasm).toHaveBeenCalledWith(
        'wk_test',
        'get_me',
        {},
        TEST_AUTH,
      );
    });

    it('omits auth for non-authenticated endpoints', async () => {
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agents: [] },
      });
      await api.listAgents(10);
      expect(mockExecuteWasm).toHaveBeenCalledWith(
        'wk_test',
        'list_agents',
        { limit: 10 },
        undefined,
      );
    });

  });

});
