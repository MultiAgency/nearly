import { api, ApiError } from '@/lib/api';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock localStorage
const mockStorage: Record<string, string> = {};
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
  },
});

beforeEach(() => {
  mockFetch.mockReset();
  api.clearApiKey();
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
});

function mockJsonResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

describe('ApiClient', () => {
  describe('API key management', () => {
    it('stores and retrieves API key', () => {
      api.setApiKey('moltbook_testkey123');
      expect(api.getApiKey()).toBe('moltbook_testkey123');
    });

    it('persists API key to localStorage', () => {
      api.setApiKey('moltbook_testkey123');
      expect(mockStorage.moltbook_api_key).toBe('moltbook_testkey123');
    });

    it('clears API key from memory and storage', () => {
      api.setApiKey('moltbook_testkey123');
      api.clearApiKey();
      expect(api.getApiKey()).toBeNull();
      expect(mockStorage.moltbook_api_key).toBeUndefined();
    });

    it('falls back to localStorage when memory is empty', () => {
      mockStorage.moltbook_api_key = 'moltbook_fromstore';
      api.clearApiKey(); // clear memory only
      // Manually set storage after clear
      mockStorage.moltbook_api_key = 'moltbook_fromstore';
      expect(api.getApiKey()).toBe('moltbook_fromstore');
    });
  });

  describe('request construction', () => {
    it('sends GET request with correct URL', async () => {
      mockJsonResponse({ data: [], total: 0, offset: 0, limit: 25 });
      await api.getPosts({ sort: 'new', limit: 10 });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/posts');
      expect(url).toContain('sort=new');
      expect(url).toContain('limit=10');
      expect(options.method).toBe('GET');
    });

    it('sends POST request with JSON body', async () => {
      mockJsonResponse({ post: { id: '1', title: 'Test' } });
      await api.createPost({
        title: 'Test',
        content: 'Body',
        submolt: 'general',
        postType: 'text',
      } as never);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(options.body);
      expect(body.title).toBe('Test');
    });

    it('includes Authorization header when API key is set', async () => {
      api.setApiKey('moltbook_mykey');
      mockJsonResponse({ agent: { id: '1', name: 'test' } });
      await api.getMe();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers.Authorization).toBe('Bearer moltbook_mykey');
    });

    it('omits Authorization header when no API key', async () => {
      mockJsonResponse({ agent: { id: '1', name: 'test' } });
      await api.getMe();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers.Authorization).toBeUndefined();
    });

    it('omits undefined query params', async () => {
      mockJsonResponse({ data: [], total: 0, offset: 0, limit: 25 });
      await api.getPosts({ sort: 'hot' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain('submolt=');
    });
  });

  describe('error handling', () => {
    it('throws ApiError on non-ok response', async () => {
      mockJsonResponse(
        { error: 'Not found', code: 'NOT_FOUND', hint: 'Check the ID' },
        404,
      );

      await expect(api.getPost('nonexistent')).rejects.toThrow(ApiError);
    });

    it('includes status code and message in ApiError', async () => {
      mockJsonResponse({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

      try {
        await api.getMe();
        fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).statusCode).toBe(401);
        expect((e as ApiError).message).toBe('Unauthorized');
        expect((e as ApiError).code).toBe('AUTH_REQUIRED');
      }
    });

    it('handles malformed error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      try {
        await api.getMe();
        fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).statusCode).toBe(500);
        expect((e as ApiError).message).toBe('Unknown error');
      }
    });
  });

  describe('endpoint methods', () => {
    it('register sends correct payload', async () => {
      mockJsonResponse({
        agent: {
          api_key: 'moltbook_abc',
          claim_url: 'https://example.com',
          verification_code: 'alpha-1234',
        },
        important: 'Save your key',
      });

      const result = await api.register({
        name: 'test_agent',
        description: 'A test',
      });
      expect(result.agent.api_key).toBe('moltbook_abc');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe('test_agent');
    });

    it('upvotePost sends POST to correct path', async () => {
      mockJsonResponse({ success: true, action: 'upvoted' });
      const result = await api.upvotePost('post123');

      expect(result.action).toBe('upvoted');
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/posts/post123/upvote');
      expect(options.method).toBe('POST');
    });

    it('deletePost sends DELETE', async () => {
      mockJsonResponse({ success: true });
      await api.deletePost('post123');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/posts/post123');
      expect(options.method).toBe('DELETE');
    });

    it('search passes query param', async () => {
      mockJsonResponse({ posts: [], agents: [], submolts: [] });
      await api.search('test query', { limit: 10 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('q=test+query');
      expect(url).toContain('limit=10');
    });

    it('getComments unwraps response', async () => {
      mockJsonResponse({
        comments: [{ id: '1', content: 'Hello' }],
      });
      const comments = await api.getComments('post1');
      expect(comments).toHaveLength(1);
      expect(comments[0].content).toBe('Hello');
    });

    it('followAgent sends POST', async () => {
      mockJsonResponse({ success: true });
      await api.followAgent('bob');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/agents/bob/follow');
      expect(options.method).toBe('POST');
    });

    it('unfollowAgent sends DELETE', async () => {
      mockJsonResponse({ success: true });
      await api.unfollowAgent('bob');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/agents/bob/follow');
      expect(options.method).toBe('DELETE');
    });
  });
});
