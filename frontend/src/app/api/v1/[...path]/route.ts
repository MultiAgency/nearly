import { type NextRequest, NextResponse } from 'next/server';
import {
  getCached,
  invalidateForMutation,
  makeCacheKey,
  setCache,
} from '@/lib/cache';
import { LIMITS } from '@/lib/constants';
import { kvGetAgent } from '@/lib/fastdata';
import {
  dispatchFastData,
  handleGetSuggested,
  type VrfProof,
} from '@/lib/fastdata-dispatch';
import { buildSyncEntries, syncToFastData } from '@/lib/fastdata-sync';
import {
  dispatchDirectWrite,
  handleDirectAdminDeregister,
} from '@/lib/fastdata-write';
import {
  callOutlayer,
  getOutlayerPaymentKey,
  mintClaimForWalletKey,
  resolveAccountId,
  sanitizePublic,
} from '@/lib/outlayer-server';
import {
  handleRegisterPlatforms,
  PLATFORM_META,
  tryPlatformRegistrationsOnRegister,
} from '@/lib/platforms';
import { PUBLIC_ACTIONS, type ResolvedRoute, resolveRoute } from '@/lib/routes';

/**
 * Decode a Bearer near:<base64url> token into its constituent fields.
 * Returns null if the token is not a valid near: token.
 */
function decodeNearToken(
  token: string,
): { account_id: string; seed: string } | null {
  if (!token.startsWith('near:')) return null;
  try {
    const b64 = token.slice(5).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof parsed.account_id === 'string' &&
      typeof parsed.seed === 'string'
    ) {
      return {
        account_id: parsed.account_id as string,
        seed: parsed.seed as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the caller's handle from an auth token.
 * wk_ key → account ID (via OutLayer sign-message) → handle (via FastData).
 * near: token → account ID (decoded from token) → handle (via FastData).
 */
async function resolveCallerHandle(authKey: string): Promise<string | null> {
  const nearToken = decodeNearToken(authKey);
  const accountId = nearToken
    ? nearToken.account_id
    : await resolveAccountId(authKey);
  if (!accountId) return null;
  return (await kvGetAgent(accountId, 'name')) as string | null;
}

const INT_FIELDS = new Set(['limit']);
const VALID_SORTS = new Set(['followers', 'endorsements', 'newest', 'active']);
const VALID_DIRECTIONS = new Set(['incoming', 'outgoing', 'both']);
const CURSOR_RE = /^[a-z0-9_]{1,32}$|^\d{1,20}$/;
const MAX_BODY_BYTES = LIMITS.MAX_BODY_BYTES;

const DIRECT_WRITE_ACTIONS = new Set([
  'follow',
  'unfollow',
  'endorse',
  'unendorse',
  'update_me',
  'heartbeat',
  'deregister',
]);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function extractQueryParams(
  url: URL,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(allowedFields);
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) continue;
    if (INT_FIELDS.has(key)) {
      if (/^\d+$/.test(value)) params[key] = parseInt(value, 10);
    } else if (key === 'include_history') {
      params[key] = value === 'true';
    } else if (key === 'sort') {
      if (VALID_SORTS.has(value)) params[key] = value;
    } else if (key === 'cursor') {
      if (value === '' || CURSOR_RE.test(value)) params[key] = value;
    } else if (key === 'since') {
      if (/^\d{1,20}$/.test(value)) params[key] = value;
    } else if (key === 'direction') {
      if (VALID_DIRECTIONS.has(value)) params[key] = value;
    } else if (key === 'tag') {
      if (value.length <= 30 && /^[a-z0-9-]+$/.test(value)) params[key] = value;
    } else {
      params[key] = value;
    }
  }
  return params;
}

function applyHeaders(response: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

function tooLargeResponse(): NextResponse {
  return applyHeaders(
    NextResponse.json(
      {
        success: false,
        error: `Request body too large (max ${MAX_BODY_BYTES / 1024} KB)`,
        code: 'VALIDATION_ERROR',
      },
      { status: 413 },
    ),
  );
}

async function dispatch(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const route = resolveRoute(request.method, path);

  if (!route) {
    return applyHeaders(
      NextResponse.json(
        { success: false, error: 'Not found', code: 'NOT_FOUND' },
        { status: 404 },
      ),
    );
  }

  const isPublic = PUBLIC_ACTIONS.has(route.action);

  const authHeader = request.headers.get('authorization');
  const userAuthKey =
    authHeader?.match(/^Bearer\s+(wk_[A-Za-z0-9_-]+)$/)?.[1] ??
    authHeader?.match(/^Bearer\s+(near:[A-Za-z0-9_+/=-]+)$/)?.[1];

  let wasmBody: Record<string, unknown>;

  if (request.method === 'GET') {
    wasmBody = {
      ...extractQueryParams(new URL(request.url), route.queryFields),
      ...route.pathParams,
      action: route.action,
    };
  } else {
    const contentLength = parseInt(
      request.headers.get('content-length') ?? '0',
      10,
    );
    if (contentLength > MAX_BODY_BYTES) return tooLargeResponse();
    let body: Record<string, unknown> = {};
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return tooLargeResponse();
      if (text) {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          return applyHeaders(
            NextResponse.json(
              {
                success: false,
                error: 'Request body must be a JSON object',
                code: 'VALIDATION_ERROR',
              },
              { status: 400 },
            ),
          );
        }
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return applyHeaders(
        NextResponse.json(
          {
            success: false,
            error: 'Invalid JSON body',
            code: 'VALIDATION_ERROR',
          },
          { status: 400 },
        ),
      );
    }
    wasmBody = { ...body, ...route.pathParams, action: route.action };
  }

  const response = isPublic
    ? await dispatchPublic(request, route, wasmBody)
    : await dispatchAuthenticated(request, route, wasmBody, userAuthKey);
  return applyHeaders(response);
}

async function dispatchPublic(
  _request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  if (route.action === 'list_platforms') {
    return NextResponse.json({
      success: true,
      data: { platforms: PLATFORM_META },
    });
  }

  const sanitized = sanitizePublic(wasmBody);
  const cacheKey = makeCacheKey(sanitized);
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }
  const result = await dispatchFastData(route.action, sanitized);
  if ('error' in result) {
    const status = result.status ?? 404;
    return NextResponse.json(
      {
        success: false,
        error: result.error,
        code: 'NOT_FOUND',
      },
      { status },
    );
  }
  const data = { success: true, data: result.data };
  setCache(route.action, cacheKey, data);
  return NextResponse.json(data);
}

async function dispatchAuthenticated(
  request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
  userAuthKey: string | undefined,
): Promise<NextResponse> {
  // Direct write path — bypasses WASM and auto-sign entirely.
  // Requires wk_ custody wallet key (FastData writes go through /wallet/v1/call
  // which signs inside the TEE — near: token support is unconfirmed for writes).
  if (
    userAuthKey?.startsWith('wk_') &&
    DIRECT_WRITE_ACTIONS.has(route.action)
  ) {
    const result = await dispatchDirectWrite(
      route.action,
      wasmBody,
      userAuthKey,
      resolveAccountId,
    );

    if (result.success) {
      invalidateForMutation(route.action);
      return NextResponse.json({ success: true, data: result.data });
    }

    const errBody: Record<string, unknown> = {
      success: false,
      error: result.error,
      code: result.code,
    };
    if (result.retryAfter) errBody.retry_after = result.retryAfter;
    return NextResponse.json(errBody, { status: result.status });
  }

  // Admin actions — require wk_ key from an admin account.
  if (route.action === 'reconcile_all' || route.action === 'admin_deregister') {
    if (!userAuthKey?.startsWith('wk_')) {
      return applyHeaders(
        NextResponse.json(
          {
            success: false,
            error:
              'Admin actions require a wallet key (Authorization: Bearer wk_...)',
            code: 'AUTH_REQUIRED',
          },
          { status: 401 },
        ),
      );
    }
    const adminAccountId = await resolveAccountId(userAuthKey);
    if (!adminAccountId) {
      return applyHeaders(
        NextResponse.json(
          {
            success: false,
            error: 'Could not resolve admin account',
            code: 'AUTH_FAILED',
          },
          { status: 401 },
        ),
      );
    }
    const expectedAdmin = process.env.OUTLAYER_ADMIN_ACCOUNT || 'hack.near';
    if (adminAccountId !== expectedAdmin) {
      return applyHeaders(
        NextResponse.json(
          {
            success: false,
            error: 'Unauthorized: admin access required',
            code: 'AUTH_FAILED',
          },
          { status: 401 },
        ),
      );
    }

    if (route.action === 'reconcile_all') {
      const result = await dispatchFastData('reconcile_all', wasmBody);
      if ('error' in result) {
        return applyHeaders(
          NextResponse.json(
            { success: false, error: result.error, code: 'INTERNAL_ERROR' },
            { status: (result as { status?: number }).status ?? 500 },
          ),
        );
      }
      return applyHeaders(
        NextResponse.json({ success: true, data: result.data }),
      );
    }

    // admin_deregister
    const targetHandle = (wasmBody.handle as string)?.toLowerCase();
    if (!targetHandle) {
      return applyHeaders(
        NextResponse.json(
          {
            success: false,
            error: 'Handle is required',
            code: 'VALIDATION_ERROR',
          },
          { status: 400 },
        ),
      );
    }
    const result = await handleDirectAdminDeregister(userAuthKey, targetHandle);
    if (result.success) {
      invalidateForMutation('admin_deregister');
      return applyHeaders(
        NextResponse.json({ success: true, data: result.data }),
      );
    }
    const errBody: Record<string, unknown> = {
      success: false,
      error: result.error,
      code: result.code,
    };
    return applyHeaders(NextResponse.json(errBody, { status: result.status }));
  }

  if (!userAuthKey) {
    console.warn(`[auth] 401 ${request.method} ${route.action}`);
    return NextResponse.json(
      {
        success: false,
        error:
          'Authentication required. Provide Authorization: Bearer wk_... or Bearer near:<token>',
        code: 'AUTH_REQUIRED',
      },
      { status: 401 },
    );
  }

  // Authenticated reads go through FastData.
  if (request.method === 'GET') {
    const handle = await resolveCallerHandle(userAuthKey);
    if (!handle) {
      return applyHeaders(
        NextResponse.json(
          { success: false, error: 'Agent not found', code: 'NOT_FOUND' },
          { status: 404 },
        ),
      );
    }

    // get_suggested: fetch VRF seed from WASM TEE, then rank deterministically.
    if (route.action === 'get_suggested') {
      let vrfProof: VrfProof | null = null;
      const claim = await mintClaimForWalletKey(userAuthKey, 'get_vrf_seed');
      if (claim) {
        const serverKey = getOutlayerPaymentKey();
        const { decoded } = await callOutlayer(
          {
            action: 'get_vrf_seed',
            verifiable_claim: {
              near_account_id: claim.near_account_id,
              public_key: claim.public_key,
              signature: claim.signature,
              nonce: claim.nonce,
              message: claim.message,
            },
          },
          serverKey || userAuthKey,
        );
        if (decoded?.success) {
          const d = decoded.data as Record<string, string>;
          vrfProof = {
            output_hex: d.output_hex,
            signature_hex: d.signature_hex,
            alpha: d.alpha,
            vrf_public_key: d.vrf_public_key,
          };
        }
      }
      const fdResult = await handleGetSuggested(
        { ...wasmBody, handle },
        vrfProof,
      );
      if ('error' in fdResult) {
        return applyHeaders(
          NextResponse.json(
            { success: false, error: fdResult.error, code: 'NOT_FOUND' },
            { status: fdResult.status ?? 404 },
          ),
        );
      }
      return applyHeaders(
        NextResponse.json({ success: true, data: fdResult.data }),
      );
    }

    const fdResult = await dispatchFastData(route.action, {
      ...wasmBody,
      handle,
    });
    if ('error' in fdResult) {
      return applyHeaders(
        NextResponse.json(
          {
            success: false,
            error: (fdResult as { error: string }).error,
            code: 'NOT_FOUND',
          },
          { status: (fdResult as { status?: number }).status ?? 404 },
        ),
      );
    }
    const data = { success: true, data: fdResult.data };
    setCache(route.action, makeCacheKey({ ...wasmBody, handle }), data);
    return applyHeaders(NextResponse.json(data));
  }

  // Platform registration — handled entirely by the proxy.
  if (route.action === 'register_platforms') {
    return handleRegisterPlatforms(userAuthKey, wasmBody);
  }

  // Registration — the only action that goes through WASM.
  if (route.action === 'register') {
    // Auto-sign: mint a verifiable_claim from the wk_ key so the WASM
    // can verify identity via NEP-413. Switch to the server payment key
    // so OutLayer charges the project, not the trial wallet.
    let authKey: string = userAuthKey;
    if (!wasmBody.verifiable_claim) {
      const claim = await mintClaimForWalletKey(userAuthKey, 'register');
      if (claim) {
        wasmBody.verifiable_claim = {
          near_account_id: claim.near_account_id,
          public_key: claim.public_key,
          signature: claim.signature,
          nonce: claim.nonce,
          message: claim.message,
        };
        const serverKey = getOutlayerPaymentKey();
        if (serverKey) authKey = serverKey;
      }
    }

    const { response: result, decoded } = await callOutlayer(wasmBody, authKey);

    // Sync registration data to FastData.
    if (decoded?.success) {
      const entries = buildSyncEntries(
        'register',
        decoded.data as Record<string, unknown>,
      );
      if (entries) syncToFastData(userAuthKey, entries);
      invalidateForMutation('register');

      // Fire platform registrations in the background.
      tryPlatformRegistrationsOnRegister(
        wasmBody,
        new NextResponse(result.clone().body, result),
        userAuthKey,
      ).catch((err) => console.error('[platforms] auto-register failed:', err));
    }

    return result;
  }

  // near: token attempting a mutation — reject with actionable guidance.
  if (
    userAuthKey?.startsWith('near:') &&
    DIRECT_WRITE_ACTIONS.has(route.action)
  ) {
    return applyHeaders(
      NextResponse.json(
        {
          success: false,
          error:
            'Mutations require a wk_ custody wallet key. Bearer near: tokens are read-only. Register a wallet via POST /register to get a wk_ key.',
          code: 'AUTH_REQUIRED',
        },
        { status: 401 },
      ),
    );
  }

  // All other authenticated POST/PATCH/DELETE mutations go through
  // direct FastData writes (handled above via DIRECT_WRITE_ACTIONS).
  // If we reach here, the action is not recognized.
  return applyHeaders(
    NextResponse.json(
      {
        success: false,
        error: `Unknown action: ${route.action}`,
        code: 'NOT_FOUND',
      },
      { status: 404 },
    ),
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
