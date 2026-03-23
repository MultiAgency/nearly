/**
 * @jest-environment node
 */

/**
 * Integration tests for the /api/v1/[...path] route handler.
 *
 * Mocks callOutlayer (the upstream boundary) and rate-limit to test:
 * - Route resolution for all supported paths
 * - Query param extraction and integer parsing
 * - Auth dispatch (public, payment key, NEP-413, unauthenticated)
 * - Action/handle injection prevention
 * - Rate limiting (429)
 * - Invalid JSON body (400)
 * - Unknown route (404)
 */

import { NextRequest } from 'next/server';

// Mock the upstream call — this is the integration boundary
const mockCallOutlayer = jest.fn();
jest.mock('@/lib/outlayer-route', () => ({
  OUTLAYER_PAYMENT_KEY: 'pk_test',
  sanitizePublic: jest.requireActual('@/lib/outlayer-route').sanitizePublic,
  callOutlayer: (...args: unknown[]) => mockCallOutlayer(...args),
}));

// Mock rate limiting — tested separately in rate-limit.test.ts
const mockCheckRateLimit = jest.fn().mockReturnValue({ limited: false, remaining: 59, resetAt: 1700000060 });
jest.mock('@/lib/rate-limit', () => ({
  RATE_LIMIT: 60,
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: () => '127.0.0.1',
}));

// Mock cache — tested separately
jest.mock('@/lib/cache', () => ({
  getCached: jest.fn().mockReturnValue(undefined),
  setCache: jest.fn(),
  makeCacheKey: jest.fn((body: Record<string, unknown>) => JSON.stringify(body)),
}));

import { GET, POST, PATCH, DELETE, OPTIONS } from '../src/app/api/v1/[...path]/route';
import { NextResponse } from 'next/server';

function makeRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): [NextRequest, { params: Promise<{ path: string[] }> }] {
  const url = `http://localhost:3000/api/v1/${path}`;
  const init: Record<string, unknown> = { method, headers: headers ?? {} };
  if (body) init.body = JSON.stringify(body);
  const req = new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]);
  // Strip query string before splitting into path segments
  const pathOnly = path.split('?')[0];
  const segments = pathOnly.split('/').filter(Boolean);
  return [req, { params: Promise.resolve({ path: segments }) }];
}

async function json(res: NextResponse) {
  return res.json();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallOutlayer.mockResolvedValue(
    NextResponse.json({ success: true, data: {} }),
  );
  mockCheckRateLimit.mockReturnValue({ limited: false, remaining: 59, resetAt: 1700000060 });
});

// ─── Route resolution ─────────────────────────────────────────────────────

describe('route resolution', () => {
  it.each([
    ['GET', 'health', 'health'],
    ['GET', 'tags', 'list_tags'],
    ['GET', 'agents', 'list_agents'],
    ['POST', 'agents/register', 'register'],
    ['GET', 'agents/suggested', 'get_suggested'],
    ['GET', 'agents/me', 'get_me'],
    ['PATCH', 'agents/me', 'update_me'],
    ['POST', 'agents/me/heartbeat', 'heartbeat'],
    ['GET', 'agents/me/activity', 'get_activity'],
    ['GET', 'agents/me/network', 'get_network'],
    ['GET', 'agents/me/notifications', 'get_notifications'],
    ['POST', 'agents/me/notifications/read', 'read_notifications'],
    ['GET', 'agents/alice', 'get_profile'],
    ['POST', 'agents/alice/follow', 'follow'],
    ['DELETE', 'agents/alice/follow', 'unfollow'],
    ['GET', 'agents/alice/followers', 'get_followers'],
    ['GET', 'agents/alice/following', 'get_following'],
    ['GET', 'agents/alice/edges', 'get_edges'],
  ])('%s %s → %s', async (method: string, path: string, expectedAction: string) => {
    const handlers: Record<string, typeof GET> = { GET, POST, PATCH, DELETE };
    const handler = handlers[method]!;
    const headers: Record<string, string> = {};

    // Authenticated actions need a payment key or auth
    const publicActions = new Set([
      'list_agents', 'get_profile', 'get_followers', 'get_following',
      'get_edges', 'list_tags', 'health',
    ]);
    if (!publicActions.has(expectedAction)) {
      headers['x-payment-key'] = 'pk_user';
    }

    const [req, params] = makeRequest(method, path, undefined, headers);
    await handler(req, params);

    expect(mockCallOutlayer).toHaveBeenCalledTimes(1);
    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.action).toBe(expectedAction);
  });

  it('returns 404 for unknown routes', async () => {
    const [req, params] = makeRequest('GET', 'unknown/path');
    const res = await GET(req, params);
    expect(res.status).toBe(404);
  });
});

// ─── Query param extraction ───────────────────────────────────────────────

describe('query params', () => {
  it('parses limit and since as integers', async () => {
    const [req, params] = makeRequest('GET', 'agents?limit=25&since=1700000000');
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.limit).toBe(25);
    expect(wasmBody.since).toBe(1700000000);
  });

  it('parses include_history as boolean', async () => {
    const [req, params] = makeRequest('GET', 'agents/alice/edges?include_history=true');
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.include_history).toBe(true);
  });

  it('passes string params through', async () => {
    const [req, params] = makeRequest('GET', 'agents?sort=newest&cursor=agent_42');
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.sort).toBe('newest');
    expect(wasmBody.cursor).toBe('agent_42');
  });

  it('drops non-parseable integer params', async () => {
    const [req, params] = makeRequest('GET', 'agents?limit=abc');
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.limit).toBeUndefined();
  });

  it('parses include_history=false as false', async () => {
    const [req, params] = makeRequest('GET', 'agents/alice/edges?include_history=false');
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.include_history).toBe(false);
  });
});

// ─── Injection prevention ─────────────────────────────────────────────────

describe('injection prevention', () => {
  it('route params override body action to prevent action injection', async () => {
    const [req, params] = makeRequest(
      'POST', 'agents/register',
      { action: 'get_me', handle: 'alice' },
      { 'x-payment-key': 'pk_user' },
    );
    await POST(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.action).toBe('register');
  });

  it('route params override body handle to prevent handle injection', async () => {
    const [req, params] = makeRequest(
      'POST', 'agents/alice/follow',
      { handle: 'mallory' },
      { 'x-payment-key': 'pk_user' },
    );
    await POST(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.handle).toBe('alice');
  });

  it('sanitizePublic strips verifiable_claim and unknown fields on public reads', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents?limit=10&verifiable_claim=evil&password=secret',
    );
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.verifiable_claim).toBeUndefined();
    expect(wasmBody.password).toBeUndefined();
    expect(wasmBody.limit).toBe(10);
  });
});

// ─── Auth dispatch ────────────────────────────────────────────────────────

describe('auth dispatch', () => {
  it('public actions use payment key from env', async () => {
    const [req, params] = makeRequest('GET', 'agents');
    await GET(req, params);

    const paymentKey = mockCallOutlayer.mock.calls[0][1];
    expect(paymentKey).toBe('pk_test');
  });

  it('x-payment-key header forwards for authenticated actions', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      'x-payment-key': 'owner.near:1:secret',
    });
    await GET(req, params);

    const authKey = mockCallOutlayer.mock.calls[0][1];
    expect(authKey).toBe('owner.near:1:secret');
  });

  it('Authorization: Bearer wk_ forwards wallet key for authenticated actions', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer wk_test123',
    });
    await GET(req, params);

    const authKey = mockCallOutlayer.mock.calls[0][1];
    expect(authKey).toBe('wk_test123');
  });

  it('x-payment-key takes precedence over Authorization: Bearer', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      'x-payment-key': 'owner.near:1:secret',
      authorization: 'Bearer wk_test123',
    });
    await GET(req, params);

    const authKey = mockCallOutlayer.mock.calls[0][1];
    expect(authKey).toBe('owner.near:1:secret');
  });

  it('ignores non-wk_ bearer tokens', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer some_other_token',
    });
    const res = await GET(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('body verifiable_claim uses env payment key', async () => {
    const claim = { near_account_id: 'alice.near', signature: 'sig' };
    const [req, params] = makeRequest('POST', 'agents/me/heartbeat', {
      verifiable_claim: claim,
    });
    await POST(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.verifiable_claim).toEqual(claim);
    const paymentKey = mockCallOutlayer.mock.calls[0][1];
    expect(paymentKey).toBe('pk_test');
  });

  it('returns 401 when no auth provided for private action', async () => {
    const [req, params] = makeRequest('GET', 'agents/me');
    const res = await GET(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValue({ limited: true, remaining: 0, resetAt: 1700000060 });
    const [req, params] = makeRequest('GET', 'agents');
    const res = await GET(req, params);
    expect(res.status).toBe(429);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('includes rate limit headers on every response', async () => {
    mockCheckRateLimit.mockReturnValue({ limited: false, remaining: 42, resetAt: 1700000060 });
    const [req, params] = makeRequest('GET', 'agents');
    const res = await GET(req, params);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('42');
    expect(res.headers.get('X-RateLimit-Reset')).toBe('1700000060');
  });
});

// ─── CORS ────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('includes CORS headers on responses', async () => {
    const [req, params] = makeRequest('GET', 'agents');
    const res = await GET(req, params);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Payment-Key');
  });

  it('handles OPTIONS preflight', () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });
});

// ─── Error handling ───────────────────────────────────────────────────────

describe('error handling', () => {
  it('returns 400 for invalid JSON body', async () => {
    const url = 'http://localhost:3000/api/v1/agents/register';
    const req = new NextRequest(url, {
      method: 'POST',
      body: 'not json{{{',
      headers: { 'x-payment-key': 'pk_user', 'content-type': 'application/json' },
    });
    const params = { params: Promise.resolve({ path: ['agents', 'register'] }) };
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('Invalid JSON');
  });
});
