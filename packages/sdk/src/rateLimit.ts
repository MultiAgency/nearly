import { RATE_LIMITS } from './constants';

/**
 * Rate limiter interface. Check-and-record is split so the funnel can
 * only count slots against the budget on successful writes — failed
 * mutations (validation, network, insufficient balance) do not consume
 * rate-limit budget.
 *
 * `check` returns the window it authorized against on success; `record`
 * accepts that window and pins the increment to it. Without threading,
 * a check at t=59.9 followed by `record` at t=60.1 would land in a
 * fresh window, letting a caller silently over-run their budget by one
 * slot per boundary crossing. Matches the frontend's post-Fix-5 behavior.
 */
export interface RateLimiter {
  check(
    action: string,
    key: string,
  ): { ok: true; window: number } | { ok: false; retryAfter: number };
  record(action: string, key: string, window?: number): void;
}

/**
 * Per-instance sliding-window rate limiter. State lives on the returned
 * closure — two instances never share counters. Matches the frontend's
 * window semantics: one fixed window per `windowSecs`, reset on rollover.
 */
export function defaultRateLimiter(): RateLimiter {
  const store = new Map<string, { window: number; count: number }>();
  return {
    check(action, key) {
      const config = RATE_LIMITS[action];
      if (!config) return { ok: true, window: 0 };
      const now = Math.floor(Date.now() / 1000);
      const window = Math.floor(now / config.windowSecs);
      const entry = store.get(`${action}:${key}`);
      if (!entry || entry.window !== window) return { ok: true, window };
      if (entry.count >= config.limit) {
        const retryAfter = (window + 1) * config.windowSecs - now;
        return { ok: false, retryAfter };
      }
      return { ok: true, window };
    },
    record(action, key, window) {
      const config = RATE_LIMITS[action];
      if (!config) return;
      const now = Math.floor(Date.now() / 1000);
      const targetWindow = window ?? Math.floor(now / config.windowSecs);
      const k = `${action}:${key}`;
      const entry = store.get(k);
      if (!entry) {
        store.set(k, { window: targetWindow, count: 1 });
        return;
      }
      if (entry.window === targetWindow) {
        entry.count++;
        return;
      }
      if (entry.window < targetWindow) {
        store.set(k, { window: targetWindow, count: 1 });
        return;
      }
      // entry.window > targetWindow: a late record pinned to an old
      // window whose entry has already been replaced. The original
      // window is gone; dropping is safer than double-counting in the
      // current bucket.
    },
  };
}

/** No-op limiter for callers that pass `{ rateLimiting: false }`. */
export function noopRateLimiter(): RateLimiter {
  return {
    check: () => ({ ok: true, window: 0 }),
    record: () => {},
  };
}
