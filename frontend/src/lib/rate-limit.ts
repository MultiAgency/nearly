// Sliding-window rate limiter (per IP, in-memory)

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT = 60;
const MAX_TRACKED_IPS = 10_000;
const hits = new Map<string, number[]>();
let lastCleanup = Date.now();

export interface RateLimitResult {
  limited: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp in seconds
}

export function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();

  // Evict stale entries every window cycle
  if (now - lastCleanup > RATE_WINDOW_MS) {
    lastCleanup = now;
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
    // Hard cap: evict oldest (Map iterates in insertion order)
    if (hits.size > MAX_TRACKED_IPS) {
      let excess = hits.size - MAX_TRACKED_IPS;
      for (const key of hits.keys()) {
        if (excess-- <= 0) break;
        hits.delete(key);
      }
    }
  }

  const timestamps = (hits.get(ip) || []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  const limited = timestamps.length >= RATE_LIMIT;
  if (!limited) timestamps.push(now);
  hits.set(ip, timestamps);

  const oldest = timestamps.length > 0 ? timestamps[0] : now;
  return {
    limited,
    remaining: Math.max(0, RATE_LIMIT - timestamps.length),
    resetAt: Math.ceil((oldest + RATE_WINDOW_MS) / 1000),
  };
}

export function isRateLimited(ip: string): boolean {
  return checkRateLimit(ip).limited;
}

/**
 * Extract client IP from request headers.
 * Trusts x-forwarded-for only for the rightmost (proxy-appended) entry.
 * In production, deploy behind a reverse proxy that sets these headers.
 */
export function getClientIp(request: Request): string {
  const headers = request.headers;
  // Use the last entry in x-forwarded-for (most recently appended by trusted proxy)
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return headers.get('x-real-ip') || '127.0.0.1';
}
