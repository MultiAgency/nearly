import {
  checkRateLimit,
  checkRateLimitBudget,
  incrementRateLimit,
} from '@/lib/rate-limit';

beforeEach(() => {
  jest.useFakeTimers();
  // Set clock to a round window boundary (divisible by 60)
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('checkRateLimit', () => {
  it('allows requests within limit', () => {
    // follow limit is 10 per 60s
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit('social.follow', 'alice.near')).toMatchObject({
        ok: true,
      });
      incrementRateLimit('social.follow', 'alice.near');
    }
  });

  it('rejects requests exceeding limit', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    const result = checkRateLimit('social.follow', 'alice.near');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it('resets after window expires', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    expect(checkRateLimit('social.follow', 'alice.near').ok).toBe(false);

    // Advance past the 60s window
    jest.advanceTimersByTime(61_000);

    expect(checkRateLimit('social.follow', 'alice.near')).toMatchObject({
      ok: true,
    });
  });

  it('isolates by caller', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    expect(checkRateLimit('social.follow', 'alice.near').ok).toBe(false);
    expect(checkRateLimit('social.follow', 'bob.near')).toMatchObject({
      ok: true,
    });
  });

  it('isolates by action', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    expect(checkRateLimit('social.follow', 'alice.near').ok).toBe(false);
    // endorse has its own limit (20), not exhausted
    expect(checkRateLimit('social.endorse', 'alice.near')).toMatchObject({
      ok: true,
    });
  });

  it('fails closed on unknown actions (no rate limit configured)', () => {
    expect(checkRateLimit('unknown_action', 'alice.near')).toEqual({
      ok: false,
      retryAfter: 60,
    });
  });
});

describe('incrementRateLimit', () => {
  it('starts a new window when none exists', () => {
    incrementRateLimit('social.follow', 'alice.near');
    // Should have counted 1, so 9 more are allowed
    for (let i = 0; i < 9; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    expect(checkRateLimit('social.follow', 'alice.near').ok).toBe(false);
  });

  it('ignores unknown actions', () => {
    // incrementRateLimit is a no-op for unmapped actions; checkRateLimit
    // fails closed regardless.
    incrementRateLimit('unknown_action', 'alice.near');
    expect(checkRateLimit('unknown_action', 'alice.near')).toEqual({
      ok: false,
      retryAfter: 60,
    });
  });

  it('pins a threaded increment to the authorizing window across a boundary', () => {
    // Advance to a clean state so prior test increments don't leak.
    jest.advanceTimersByTime(301_000);

    // Check at t=0 — authorized against window W.
    const check = checkRateLimit('social.follow', 'bob.near');
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const authorizedWindow = check.window;

    // "Work" takes longer than the 60s window. Increment lands after
    // the boundary, but we thread the original window through.
    jest.advanceTimersByTime(61_000);
    incrementRateLimit('social.follow', 'bob.near', authorizedWindow);

    // The new window's budget is untouched: the late increment pinned to
    // the stale window and did not consume a slot in the current one.
    expect(checkRateLimitBudget('social.follow', 'bob.near')).toMatchObject({
      ok: true,
      remaining: 10,
    });
  });

  it('drops a late increment whose pinned window is older than the current entry', () => {
    jest.advanceTimersByTime(301_000);

    // Check + increment in window W populates the store at window W.
    const first = checkRateLimit('social.follow', 'carol.near');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    incrementRateLimit('social.follow', 'carol.near', first.window);

    // Advance to window W+1 and do a proper check+increment there.
    jest.advanceTimersByTime(61_000);
    const second = checkRateLimit('social.follow', 'carol.near');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    incrementRateLimit('social.follow', 'carol.near', second.window);

    // Now a late increment arrives pinned to window W. The store is at W+1;
    // the old window cannot be resurrected, and we should not pollute the
    // current bucket, so the late increment is dropped.
    incrementRateLimit('social.follow', 'carol.near', first.window);

    // Current-window budget is still 9 (1 increment from `second`, not 2).
    expect(checkRateLimitBudget('social.follow', 'carol.near')).toMatchObject({
      ok: true,
      remaining: 9,
    });
  });
});

describe('checkRateLimitBudget', () => {
  beforeEach(() => {
    // Advance to a fresh window so prior test state doesn't leak
    jest.advanceTimersByTime(301_000);
  });

  it('returns full budget when no requests made', () => {
    const result = checkRateLimitBudget('social.follow', 'alice.near');
    expect(result).toMatchObject({ ok: true, remaining: 10 });
  });

  it('returns remaining budget after some requests', () => {
    for (let i = 0; i < 3; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    const result = checkRateLimitBudget('social.follow', 'alice.near');
    expect(result).toMatchObject({ ok: true, remaining: 7 });
  });

  it('returns error when budget exhausted', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    const result = checkRateLimitBudget('social.follow', 'alice.near');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfter).toBeGreaterThan(0);
    }
  });

  it('fails closed for unknown actions', () => {
    const result = checkRateLimitBudget('unknown_action', 'alice.near');
    expect(result).toEqual({ ok: false, retryAfter: 60 });
  });

  it('resets budget after window expires', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('social.follow', 'alice.near');
    }
    expect(checkRateLimitBudget('social.follow', 'alice.near').ok).toBe(false);

    jest.advanceTimersByTime(61_000);

    const result = checkRateLimitBudget('social.follow', 'alice.near');
    expect(result).toMatchObject({ ok: true, remaining: 10 });
  });

  it('respects action-specific limits (delist_me = 1 per 300s)', () => {
    expect(
      checkRateLimitBudget('social.delist_me', 'alice.near'),
    ).toMatchObject({
      ok: true,
      remaining: 1,
    });

    incrementRateLimit('social.delist_me', 'alice.near');

    const result = checkRateLimitBudget('social.delist_me', 'alice.near');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(300);
    }
  });
});
