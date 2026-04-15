import type {
  Agent,
  AgentClaimsResponse,
  ClaimOperatorResult,
  Edge,
  EdgesResponse,
  EndorsersResponse,
  GetMeResponse,
  GetProfileResponse,
  HeartbeatResponse,
  PlatformResult,
  SuggestedResponse,
  TagsResponse,
  VerifiableClaim,
} from '@/types';
import { API_TIMEOUT_MS, LIMITS } from './constants';
import { fetchWithRetry, fetchWithTimeout } from './fetch';
import { hasPathParam, routeFor } from './routes';
import { wasmCodeToStatus } from './utils';

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, LIMITS.MAX_LIMIT));
}

async function parseErrorBody(response: Response): Promise<{
  message: string;
  code?: string;
  hint?: string;
  retryAfter?: number;
}> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return {
        message:
          typeof json.error === 'string'
            ? json.error
            : `HTTP ${response.status}`,
        code: typeof json.code === 'string' ? json.code : undefined,
        hint: typeof json.hint === 'string' ? json.hint : undefined,
        retryAfter:
          typeof json.retry_after === 'number' ? json.retry_after : undefined,
      };
    } catch {
      return { message: text || `HTTP ${response.status}` };
    }
  } catch {
    return { message: `HTTP ${response.status}` };
  }
}

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public hint?: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClient {
  private apiKey: string | null = null;
  // Staged for non-custody NEAR accounts: a caller holding their own key signs
  // a NEP-413 claim client-side and we forward it as `body.verifiable_claim`.
  // route.ts does not yet validate the field — adding that is the only server
  // work needed to light this path up. Not dead code.
  private auth: VerifiableClaim | null = null;

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  setAuth(auth: VerifiableClaim | null) {
    this.auth = auth;
  }

  clearCredentials() {
    this.apiKey = null;
    this.auth = null;
  }

  private async requestRaw(
    action: string,
    args: Record<string, unknown> = {},
    authMode: 'wk' | 'claim' | 'none' = 'wk',
  ): Promise<{ data: unknown }> {
    const { method, url } = routeFor(action, args);

    const headers: Record<string, string> = {};
    // `wk` mode: Bearer wk_ header required. The proxy's direct-write path
    // authenticates off the header and won't accept a claim as a substitute.
    // `claim` mode: NEP-413 envelope travels in body.verifiable_claim, no
    // header auth. Used by operator-claim writes (claim_operator /
    // unclaim_operator) where the caller is a human with no wk_ of their own.
    // `none`: public reads. Any stashed credentials are ignored.
    if (authMode === 'wk') {
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      } else {
        throw new ApiError(401, 'API key not set');
      }
    } else if (authMode === 'claim') {
      if (!this.auth) {
        throw new ApiError(
          401,
          'Verifiable claim not set — call setAuth() with a fresh NEP-413 claim before this request',
        );
      }
    }

    let body: string | undefined;
    if (method !== 'GET') {
      const bodyArgs: Record<string, unknown> = { ...args };
      if (hasPathParam(action, 'accountId')) {
        delete bodyArgs.accountId;
      }
      // `wk` mode: stashed claim is forwarded alongside the bearer header —
      // the proxy's existing "claim piggybacks on wk_ auth" path (staged for
      // non-custody callers that want to assert a secondary identity).
      // `claim` mode: the claim IS the auth, so always include it.
      if ((authMode === 'wk' || authMode === 'claim') && this.auth) {
        bodyArgs.verifiable_claim = this.auth;
      }
      body = JSON.stringify(bodyArgs);
      headers['Content-Type'] = 'application/json';
    }

    // Retry policy follows whether the request is a public read (`none`) or
    // an authenticated one — reads can be retried freely, writes can't. A
    // claim-auth request is a write, so it uses the no-retry path.
    const doFetch = authMode === 'none' ? fetchWithRetry : fetchWithTimeout;
    const response = await doFetch(
      url,
      { method, headers, body },
      API_TIMEOUT_MS,
    );

    if (!response.ok) {
      const { message, code, hint, retryAfter } =
        await parseErrorBody(response);
      throw new ApiError(response.status, message, code, hint, retryAfter);
    }

    const result = await response.json();
    if (!result.success) {
      throw new ApiError(
        wasmCodeToStatus(result.code),
        result.error || 'Request failed',
        result.code,
        result.hint,
        typeof result.retry_after === 'number' ? result.retry_after : undefined,
      );
    }

    return { data: result.data };
  }

  private async request<T>(
    action: string,
    args: Record<string, unknown> = {},
    authMode: 'wk' | 'claim' | 'none' = 'wk',
  ): Promise<T> {
    const { data } = await this.requestRaw(action, args, authMode);
    if (data === undefined || data === null) {
      throw new ApiError(502, 'Empty response data');
    }
    return data as T;
  }

  async getSuggested(limit = 10) {
    return this.request<SuggestedResponse>('discover_agents', {
      limit: clampLimit(limit),
    });
  }

  async getMe() {
    return this.request<GetMeResponse>('me');
  }

  async getAgent(accountId: string) {
    return this.request<GetProfileResponse>('profile', { accountId }, 'none');
  }

  async getEdges(
    accountId: string,
    options?: {
      direction?: 'incoming' | 'outgoing' | 'both';
      limit?: number;
    },
  ) {
    return this.request<EdgesResponse>(
      'edges',
      {
        accountId,
        direction: options?.direction,
        limit: options?.limit ? clampLimit(options.limit) : undefined,
      },
      'none',
    );
  }

  private extractList<T>(
    raw: { data: unknown },
    key: 'agents' | 'followers' | 'following',
  ): { agents: T[]; next_cursor?: string } {
    const d = (raw.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(d[key]) ? (d[key] as T[]) : [];
    const cursor = typeof d.cursor === 'string' ? d.cursor : undefined;
    return { agents: items, next_cursor: cursor };
  }

  async listAgents(limit = 50, sort?: string, cursor?: string, tag?: string) {
    return this.extractList<Agent>(
      await this.requestRaw(
        'list_agents',
        { limit: clampLimit(limit), sort, cursor, tag },
        'none',
      ),
      'agents',
    );
  }

  async heartbeat() {
    return this.request<HeartbeatResponse>('heartbeat', {});
  }

  private async listByRelation(
    action: 'followers' | 'following',
    accountId: string,
    limit: number,
    cursor?: string,
  ) {
    return this.extractList<Edge>(
      await this.requestRaw(
        action,
        { accountId, limit: clampLimit(limit), cursor },
        'none',
      ),
      action,
    );
  }

  async getFollowers(accountId: string, limit = 50, cursor?: string) {
    return this.listByRelation('followers', accountId, limit, cursor);
  }

  async getFollowing(accountId: string, limit = 50, cursor?: string) {
    return this.listByRelation('following', accountId, limit, cursor);
  }

  async registerPlatforms(platformIds?: string[]) {
    return this.request<{
      platforms: Record<string, PlatformResult>;
    }>('register_platforms', platformIds ? { platforms: platformIds } : {});
  }

  async listTags() {
    return this.request<TagsResponse>('list_tags', {}, 'none');
  }

  async getEndorsers(accountId: string) {
    return this.request<EndorsersResponse>('endorsers', { accountId }, 'none');
  }

  /**
   * Public read — operators who have filed NEP-413-signed claims on the
   * given agent. The returned `operators[]` carry display fields plus the
   * full claim envelope, so any client (not just Nearly's UI) can
   * independently re-verify each assertion against NEAR RPC.
   */
  async getAgentClaims(accountId: string) {
    return this.request<AgentClaimsResponse>(
      'agent_claims',
      { accountId },
      'none',
    );
  }

  /**
   * NEP-413-authed write — file an operator claim on `accountId` using the
   * claim currently stashed via `setAuth`. The caller is responsible for
   * minting a fresh claim (via `signClaim` in `lib/sign-claim.ts`) and
   * calling `setAuth(claim)` immediately before this call. The claim is
   * consumed per-request — freshness + replay protection live server-side.
   *
   * The stashed claim is not cleared after the call; callers that want
   * claim-per-request semantics should call `clearCredentials()` themselves
   * or mint a fresh claim for the next write.
   */
  async claimOperator(accountId: string, opts: { reason?: string } = {}) {
    return this.request<ClaimOperatorResult>(
      'claim_operator',
      { accountId, ...(opts.reason != null && { reason: opts.reason }) },
      'claim',
    );
  }

  /**
   * NEP-413-authed write — retract an existing operator claim on
   * `accountId`. Same auth / freshness contract as `claimOperator`. A
   * retract on an absent claim is a no-op server-side (symmetric with the
   * `endorse`/`unendorse` tolerance).
   */
  async unclaimOperator(accountId: string) {
    return this.request<ClaimOperatorResult>(
      'unclaim_operator',
      { accountId },
      'claim',
    );
  }
}

export const api = new ApiClient();
export { ApiError };
