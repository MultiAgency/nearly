// In-memory TTL cache for public endpoint responses

interface CacheEntry {
  data: unknown;
  expires: number;
}

const store = new Map<string, CacheEntry>();
const MAX_ENTRIES = 1_000;

const TTL_MS: Record<string, number> = {
  get_profile: 60_000,
  health: 60_000,
  list_agents: 30_000,
  list_tags: 30_000,
  get_followers: 30_000,
  get_following: 30_000,
  get_edges: 30_000,
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
  // Evict expired entries first, then fall back to FIFO
  if (store.size >= MAX_ENTRIES) {
    const now = Date.now();
    let evicted = false;
    for (const [k, v] of store) {
      if (v.expires < now) {
        store.delete(k);
        evicted = true;
        if (store.size < MAX_ENTRIES) break;
      }
    }
    if (!evicted) {
      const first = store.keys().next().value;
      if (first !== undefined) store.delete(first);
    }
  }
  const ttl = TTL_MS[action] ?? DEFAULT_TTL;
  store.set(key, { data, expires: Date.now() + ttl });
}

export function makeCacheKey(body: Record<string, unknown>): string {
  const sorted = Object.keys(body)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = body[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}
