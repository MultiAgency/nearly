// Nearly Social API Client — OutLayer WASM backend

import type {
  Agent,
  AgentCapabilities,
  Nep413Auth,
  Notification,
  RegisterAgentForm,
  RegistrationResponse,
  SuggestionReason,
} from '@/types';
import { API_TIMEOUT_MS } from './constants';
import { fetchWithTimeout, httpErrorText } from './fetch';
import {
  decodeOutlayerResponse,
  executeWasm,
  OutlayerExecError,
} from './outlayer-exec';

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClient {
  private apiKey: string | null = null;
  private auth: Nep413Auth | null = null;

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  setAuth(auth: Nep413Auth | null) {
    this.auth = auth;
  }

  clearCredentials() {
    this.apiKey = null;
    this.auth = null;
  }

  /** Route public reads through /api/v1 REST endpoints (payment key stays on server). */
  private async publicRequest<T>(
    action: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const url = this.buildPublicUrl(action, args);

    const response = await fetchWithTimeout(url, undefined, API_TIMEOUT_MS);

    if (!response.ok) {
      const text = await httpErrorText(response);
      throw new ApiError(response.status, `Public request failed: ${text}`);
    }

    const result = await response.json();

    let parsed: { success: boolean; data?: T; error?: string };
    try {
      parsed = decodeOutlayerResponse<T>(result);
    } catch {
      throw new ApiError(502, 'Failed to decode public API response');
    }

    if (!parsed.success) {
      throw new ApiError(400, parsed.error || 'Public request failed');
    }

    return parsed.data as T;
  }

  /** Map WASM action + args to v1 REST URL. */
  private buildPublicUrl(
    action: string,
    args: Record<string, unknown>,
  ): string {
    const handle = args.handle as string | undefined;
    const q = (params: Record<string, unknown>) => {
      const s = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v != null) s.set(k, String(v));
      }
      const qs = s.toString();
      return qs ? `?${qs}` : '';
    };

    switch (action) {
      case 'list_agents':
        return `/api/v1/agents${q({ limit: args.limit, sort: args.sort })}`;
      case 'get_profile':
        return `/api/v1/agents/${handle}`;
      case 'get_edges':
        return `/api/v1/agents/${handle}/edges${q({ direction: args.direction, include_history: args.include_history, limit: args.limit, cursor: args.cursor })}`;
      case 'get_followers':
        return `/api/v1/agents/${handle}/followers${q({ limit: args.limit, cursor: args.cursor })}`;
      case 'get_following':
        return `/api/v1/agents/${handle}/following${q({ limit: args.limit, cursor: args.cursor })}`;
      case 'list_tags':
        return '/api/v1/tags';
      default:
        return `/api/v1/agents${q({ ...args, action })}`;
    }
  }

  private async request<T>(
    action: string,
    args: Record<string, unknown> = {},
    requiresAuth = true,
  ): Promise<T> {
    if (!requiresAuth && !this.apiKey) {
      return this.publicRequest<T>(action, args);
    }

    const key = this.apiKey;
    if (!key) {
      throw new ApiError(401, 'API key not set');
    }

    try {
      const auth = requiresAuth ? (this.auth ?? undefined) : undefined;
      const result = await executeWasm<T>(key, action, args, auth);
      return result.data as T;
    } catch (err) {
      if (err instanceof OutlayerExecError) {
        const code = err.code?.toLowerCase();
        let statusCode = 400;
        if (code === 'unauthorized' || code === 'auth_required')
          statusCode = 401;
        else if (code === 'forbidden') statusCode = 403;
        else if (code === 'not_found') statusCode = 404;
        throw new ApiError(statusCode, err.message, err.code);
      }
      throw err;
    }
  }

  // ─── Public API methods ────────────────────────────────────────────

  async register(data: RegisterAgentForm) {
    return this.request<RegistrationResponse>('register', {
      handle: data.handle,
      description: data.description,
    });
  }

  async getSuggestedFollows(limit = 10) {
    const result = await this.request<{
      agents: (Agent & { reason?: SuggestionReason })[];
      vrf: { output: string; proof: string; alpha: string } | null;
    }>('get_suggested', { limit });
    return result.agents;
  }

  async getMe() {
    const result = await this.request<{ agent: Agent }>('get_me');
    return result.agent;
  }

  async updateMe(data: {
    display_name?: string;
    description?: string;
    tags?: string[];
    capabilities?: AgentCapabilities;
  }) {
    const result = await this.request<{ agent: Agent }>('update_me', {
      display_name: data.display_name,
      description: data.description,
      tags: data.tags,
      capabilities: data.capabilities,
    });
    return result.agent;
  }

  async getAgent(handle: string) {
    return this.request<{ agent: Agent; is_following: boolean }>(
      'get_profile',
      { handle },
      false,
    );
  }

  async followAgent(handle: string, reason?: string) {
    return this.request<{
      action: 'followed' | 'already_following';
      followed?: Agent;
      your_network?: { following_count: number; follower_count: number };
      next_suggestion?: Agent & { reason?: string; follow_url?: string };
    }>('follow', { handle, reason });
  }

  async unfollowAgent(handle: string, reason?: string) {
    return this.request<{
      action: 'unfollowed' | 'not_following';
    }>('unfollow', { handle, reason });
  }

  async getNotifications(since?: string, limit = 50) {
    return this.request<{
      notifications: Notification[];
      unread_count: number;
    }>('get_notifications', { since, limit });
  }

  async readNotifications() {
    return this.request<{ read_at: number }>('read_notifications', {});
  }

  async getEdges(
    handle: string,
    options?: {
      direction?: 'incoming' | 'outgoing' | 'both';
      includeHistory?: boolean;
      limit?: number;
      cursor?: string;
    },
  ) {
    return this.request<{
      handle: string;
      edges: (Agent & {
        direction: string;
        follow_reason?: string;
        followed_at?: number;
      })[];
      edge_count: number;
      history:
        | { handle: string; direction: string; reason?: string; ts?: number }[]
        | null;
      pagination: { limit: number; next_cursor?: string };
    }>(
      'get_edges',
      {
        handle,
        direction: options?.direction,
        include_history: options?.includeHistory,
        limit: options?.limit,
        cursor: options?.cursor,
      },
      false,
    );
  }

  async listAgents(limit = 50, sort?: string) {
    const agents = await this.request<Agent[]>(
      'list_agents',
      { limit, sort },
      false,
    );
    return { agents: Array.isArray(agents) ? agents : [] };
  }

  async heartbeat() {
    // Response shape is complex (agent + delta + suggested_action); we only care that it succeeds.
    await this.request<unknown>('heartbeat', {});
  }

  async getNetwork() {
    return this.request<{
      follower_count: number;
      following_count: number;
      mutual_count: number;
      last_active: number;
      member_since: number;
    }>('get_network', {});
  }

  async getFollowers(handle: string, limit = 50, cursor?: string) {
    // WASM paginate_json puts the array directly in data (not wrapped in { agents })
    const agents = await this.request<Agent[]>(
      'get_followers',
      { handle, limit, cursor },
      false,
    );
    return Array.isArray(agents) ? agents : [];
  }

  async getFollowing(handle: string, limit = 50, cursor?: string) {
    const agents = await this.request<Agent[]>(
      'get_following',
      { handle, limit, cursor },
      false,
    );
    return Array.isArray(agents) ? agents : [];
  }

  async listTags() {
    const result = await this.request<{
      tags: { tag: string; count: number }[];
    }>('list_tags', {}, false);
    return result.tags;
  }
}

export const api = new ApiClient();
export { ApiError };
