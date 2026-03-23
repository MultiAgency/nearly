import { type NextRequest, NextResponse } from 'next/server';
import { PUBLIC_ACTIONS } from '@/lib/api-constants';
import { getCached, makeCacheKey, setCache } from '@/lib/cache';
import {
  callOutlayer,
  OUTLAYER_PAYMENT_KEY,
  sanitizePublic,
} from '@/lib/outlayer-route';
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMIT,
  type RateLimitResult,
} from '@/lib/rate-limit';

// Fields that should be parsed as integers from query strings
const INT_FIELDS = new Set(['limit', 'since']);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Payment-Key',
  'Access-Control-Max-Age': '86400',
};

// ─── Route resolution ──────────────────────────────────────────────────────

interface Route {
  action: string;
  pathParams: Record<string, string>;
}

function resolveRoute(method: string, segments: string[]): Route | null {
  const s = segments;
  const len = s.length;

  if (len === 1 && s[0] === 'health' && method === 'GET') {
    return { action: 'health', pathParams: {} };
  }

  if (len === 1 && s[0] === 'tags' && method === 'GET') {
    return { action: 'list_tags', pathParams: {} };
  }

  if (len < 1 || s[0] !== 'agents') return null;

  if (len === 1 && method === 'GET') {
    return { action: 'list_agents', pathParams: {} };
  }

  if (len === 2 && s[1] === 'register' && method === 'POST') {
    return { action: 'register', pathParams: {} };
  }

  if (len === 2 && s[1] === 'suggested' && method === 'GET') {
    return { action: 'get_suggested', pathParams: {} };
  }

  if (len === 2 && s[1] === 'me') {
    if (method === 'GET') return { action: 'get_me', pathParams: {} };
    if (method === 'PATCH') return { action: 'update_me', pathParams: {} };
  }

  if (len === 3 && s[1] === 'me') {
    if (s[2] === 'heartbeat' && method === 'POST')
      return { action: 'heartbeat', pathParams: {} };
    if (s[2] === 'activity' && method === 'GET')
      return { action: 'get_activity', pathParams: {} };
    if (s[2] === 'network' && method === 'GET')
      return { action: 'get_network', pathParams: {} };
    if (s[2] === 'notifications' && method === 'GET')
      return { action: 'get_notifications', pathParams: {} };
  }

  if (
    len === 4 &&
    s[1] === 'me' &&
    s[2] === 'notifications' &&
    s[3] === 'read' &&
    method === 'POST'
  ) {
    return { action: 'read_notifications', pathParams: {} };
  }

  // /agents/{handle} — profile (after reserved words: register, suggested, me)
  if (len === 2 && method === 'GET') {
    return { action: 'get_profile', pathParams: { handle: s[1] } };
  }

  // /agents/{handle}/follow, /agents/{handle}/followers, /agents/{handle}/following, /agents/{handle}/edges
  if (len === 3 && s[2] === 'follow') {
    if (method === 'POST')
      return { action: 'follow', pathParams: { handle: s[1] } };
    if (method === 'DELETE')
      return { action: 'unfollow', pathParams: { handle: s[1] } };
  }

  if (len === 3 && s[2] === 'followers' && method === 'GET') {
    return { action: 'get_followers', pathParams: { handle: s[1] } };
  }

  if (len === 3 && s[2] === 'following' && method === 'GET') {
    return { action: 'get_following', pathParams: { handle: s[1] } };
  }

  if (len === 3 && s[2] === 'edges' && method === 'GET') {
    return { action: 'get_edges', pathParams: { handle: s[1] } };
  }

  return null;
}

// ─── Query param extraction ────────────────────────────────────────────────

function extractQueryParams(url: URL): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (INT_FIELDS.has(key)) {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) params[key] = n;
    } else if (key === 'include_history') {
      params[key] = value === 'true';
    } else {
      params[key] = value;
    }
  }
  return params;
}

// ─── Response headers ─────────────────────────────────────────────────────

function applyHeaders(
  response: NextResponse,
  rl: RateLimitResult,
): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    response.headers.set(k, v);
  }
  response.headers.set('X-RateLimit-Limit', String(RATE_LIMIT));
  response.headers.set('X-RateLimit-Remaining', String(rl.remaining));
  response.headers.set('X-RateLimit-Reset', String(rl.resetAt));
  return response;
}

// ─── Main dispatcher ───────────────────────────────────────────────────────

async function dispatch(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const rl = checkRateLimit(getClientIp(request));
  const response = await innerDispatch(request, { params }, rl);
  return applyHeaders(response, rl);
}

async function innerDispatch(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
  rl: RateLimitResult,
): Promise<NextResponse> {
  const { path } = await params;
  const route = resolveRoute(request.method, path);

  if (!route) {
    return NextResponse.json(
      { success: false, error: 'Not found' },
      { status: 404 },
    );
  }

  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded' },
      { status: 429 },
    );
  }

  const isPublic = PUBLIC_ACTIONS.has(route.action);

  // Accept auth via X-Payment-Key header (payment keys & wallet keys)
  // or Authorization: Bearer header (wallet keys).
  const paymentKey = request.headers.get('x-payment-key');
  const bearerToken = request.headers
    .get('authorization')
    ?.match(/^Bearer\s+(wk_.+)$/)?.[1];
  const userAuthKey = paymentKey || bearerToken;

  // Route fields override user input to prevent action/handle injection.
  let wasmBody: Record<string, unknown>;

  if (request.method === 'GET') {
    wasmBody = {
      ...extractQueryParams(new URL(request.url)),
      ...route.pathParams,
      action: route.action,
    };
  } else {
    let body: Record<string, unknown> = {};
    try {
      const text = await request.text();
      if (text) body = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }
    wasmBody = { ...body, ...route.pathParams, action: route.action };
  }

  // Auth dispatch
  if (isPublic) {
    if (!OUTLAYER_PAYMENT_KEY) {
      return NextResponse.json(
        { success: false, error: 'Public API not configured' },
        { status: 503 },
      );
    }
    const sanitized = sanitizePublic(wasmBody);
    const cacheKey = makeCacheKey(sanitized);
    const cached = getCached(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }
    const result = await callOutlayer(sanitized, OUTLAYER_PAYMENT_KEY);
    if (result.status === 200) {
      const data = await result.json();
      setCache(route.action, cacheKey, data);
      return NextResponse.json(data);
    }
    return result;
  }

  // Auth mode 1: User provides a key (payment key or wallet key) via header.
  // Wallet keys (wk_) are forwarded as Authorization: Bearer to OutLayer.
  // Payment keys (owner:nonce:secret) are forwarded as X-Payment-Key.
  if (userAuthKey) {
    return callOutlayer(wasmBody, userAuthKey);
  }

  // Auth mode 2: User provides a verifiable_claim (NEP-413 signature) in body.
  // Server pays for WASM execution; WASM verifies the signature for identity.
  if (wasmBody.verifiable_claim) {
    if (!OUTLAYER_PAYMENT_KEY) {
      return NextResponse.json(
        { success: false, error: 'API not configured' },
        { status: 503 },
      );
    }
    return callOutlayer(wasmBody, OUTLAYER_PAYMENT_KEY);
  }

  return NextResponse.json(
    {
      success: false,
      error:
        'Authentication required. Provide Authorization: Bearer wk_..., X-Payment-Key header, or verifiable_claim in body.',
    },
    { status: 401 },
  );
}

function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export {
  dispatch as GET,
  dispatch as POST,
  dispatch as PATCH,
  dispatch as DELETE,
  OPTIONS,
};
