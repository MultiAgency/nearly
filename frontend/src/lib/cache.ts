interface CacheEntry {
  data: unknown;
  expires: number;
  action: string;
}

const MAX_CACHE_ENTRIES = 500;
const store = new Map<string, CacheEntry>();

const TTL_MS: Record<string, number> = {
  profile: 60_000,
  health: 60_000,
  list_agents: 30_000,
  list_tags: 30_000,
  list_capabilities: 30_000,
  followers: 30_000,
  following: 30_000,
  edges: 30_000,
  endorsers: 30_000,
};
const DEFAULT_TTL = 30_000;

export function getCached(key: string): unknown | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return undefined;
  }
  return entry.data;
}

export function setCache(action: string, key: string, data: unknown): void {
  const ttl = TTL_MS[action] ?? DEFAULT_TTL;
  store.delete(key);
  store.set(key, { data, expires: Date.now() + ttl, action });
  if (store.size > MAX_CACHE_ENTRIES) {
    const overage = store.size - MAX_CACHE_ENTRIES;
    for (const key of Array.from(store.keys()).slice(0, overage)) {
      store.delete(key);
    }
  }
}

export function clearCache(): void {
  store.clear();
}

/** Which cached action types each mutation can invalidate.
 *  Anything not listed here falls through to full clearCache(). */
const INVALIDATION_MAP: Record<string, string[]> = {
  register: ['list_agents', 'list_tags', 'list_capabilities', 'health'],
  update_me: ['list_agents', 'list_tags', 'list_capabilities', 'profile'],
  follow: ['list_agents', 'profile', 'followers', 'following', 'edges'],
  unfollow: ['list_agents', 'profile', 'followers', 'following', 'edges'],
  endorse: ['list_agents', 'profile', 'endorsers'],
  unendorse: ['list_agents', 'profile', 'endorsers'],
  heartbeat: [
    'list_agents',
    'profile',
    'health',
    'list_tags',
    'list_capabilities',
  ],
  register_platforms: ['list_agents', 'profile', 'list_capabilities'],
  deregister: [
    'list_agents',
    'list_tags',
    'list_capabilities',
    'health',
    'profile',
    'followers',
    'following',
    'edges',
    'endorsers',
  ],
};

/** Invalidate only the cached action types affected by the given mutation.
 *  Falls back to full clearCache() for unmapped mutations. */
export function invalidateForMutation(mutation: string): void {
  const affected = INVALIDATION_MAP[mutation];
  if (!affected) {
    clearCache();
    return;
  }
  const affectedSet = new Set(affected);
  for (const [key, entry] of store) {
    if (affectedSet.has(entry.action)) store.delete(key);
  }
}

export function makeCacheKey(body: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(sorted);
}
