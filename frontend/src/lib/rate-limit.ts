/**
 * In-memory sliding-window rate limiting.
 *
 * Resets on cold start — acceptable because this is defense-in-depth,
 * not the security boundary.
 *
 * Window threading: check returns the window it authorized against;
 * increment pins to that window so a boundary crossing between check and
 * increment can't silently move the count into a fresh budget.
 */

interface WindowEntry {
  window: number;
  count: number;
}

const store = new Map<string, WindowEntry>();
let callsSinceEviction = 0;
const EVICTION_INTERVAL = 500;

/** Per-action rate limit configuration. */
const LIMITS: Record<string, { limit: number; windowSecs: number }> = {
  follow: { limit: 10, windowSecs: 60 },
  unfollow: { limit: 10, windowSecs: 60 },
  endorse: { limit: 20, windowSecs: 60 },
  unendorse: { limit: 20, windowSecs: 60 },
  update_me: { limit: 10, windowSecs: 60 },
  heartbeat: { limit: 5, windowSecs: 60 },
  delist_me: { limit: 1, windowSecs: 300 },
  // Operator-claim writes are NEP-413 auth'd (no `wk_`), so the rate-limit
  // key is the verified operator's account_id, not the request IP.
  claim_operator: { limit: 5, windowSecs: 60 },
  unclaim_operator: { limit: 5, windowSecs: 60 },
  verify_claim: { limit: 60, windowSecs: 60 },
  hidden_list: { limit: 120, windowSecs: 60 },
  list_platforms: { limit: 120, windowSecs: 60 },
};

export function checkRateLimit(
  action: string,
  callerHandle: string,
): { ok: true; window: number } | { ok: false; retryAfter: number } {
  const config = LIMITS[action];
  if (!config) return { ok: false, retryAfter: 60 };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / config.windowSecs);

  // Periodic eviction of stale entries
  if (++callsSinceEviction >= EVICTION_INTERVAL) {
    callsSinceEviction = 0;
    const minWindow = window - 1;
    for (const [k, v] of store) {
      if (v.window < minWindow) store.delete(k);
    }
  }
  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry || entry.window !== window) {
    return { ok: true, window };
  }

  if (entry.count >= config.limit) {
    const retryAfter = (window + 1) * config.windowSecs - now;
    return { ok: false, retryAfter };
  }

  return { ok: true, window };
}

/**
 * Increment rate limit counter without checking.
 * Used after successful mutation to count it against the budget.
 *
 * Pass the `window` returned by the authorizing check to pin the increment
 * to that bucket. Without it, the increment recomputes the window from the
 * current time and can drift across a boundary.
 */
export function incrementRateLimit(
  action: string,
  callerHandle: string,
  window?: number,
): void {
  const config = LIMITS[action];
  if (!config) return;

  const now = Math.floor(Date.now() / 1000);
  const targetWindow = window ?? Math.floor(now / config.windowSecs);
  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry) {
    store.set(key, { window: targetWindow, count: 1 });
    return;
  }
  if (entry.window === targetWindow) {
    entry.count++;
    return;
  }
  if (entry.window < targetWindow) {
    store.set(key, { window: targetWindow, count: 1 });
    return;
  }
  // entry.window > targetWindow: a late increment for an old window whose
  // entry has already been replaced. The request happened, but its budget is
  // stale — dropping it is safer than double-counting in the current bucket.
}

/**
 * Check remaining budget for batch operations.
 * Returns remaining count + the authorizing window, or error with retryAfter.
 */
export function checkRateLimitBudget(
  action: string,
  callerHandle: string,
):
  | { ok: true; remaining: number; window: number }
  | { ok: false; retryAfter: number } {
  const config = LIMITS[action];
  if (!config) return { ok: false, retryAfter: 60 };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / config.windowSecs);
  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry || entry.window !== window) {
    return { ok: true, remaining: config.limit, window };
  }

  if (entry.count >= config.limit) {
    const retryAfter = (window + 1) * config.windowSecs - now;
    return { ok: false, retryAfter };
  }

  return { ok: true, remaining: config.limit - entry.count, window };
}
