import { defaultRateLimiter, noopRateLimiter } from '../src/rateLimit';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('defaultRateLimiter', () => {
  it('check returns the authorizing window on success', () => {
    const rl = defaultRateLimiter();
    const result = rl.check('follow', 'alice.near');
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(typeof result.window).toBe('number');
  });

  it('allows requests within limit when threaded correctly', () => {
    const rl = defaultRateLimiter();
    // follow limit is 10 per 60s
    for (let i = 0; i < 10; i++) {
      const check = rl.check('follow', 'alice.near');
      expect(check.ok).toBe(true);
      if (check.ok) rl.record('follow', 'alice.near', check.window);
    }
    expect(rl.check('follow', 'alice.near').ok).toBe(false);
  });

  it('resets at the window rollover', () => {
    const rl = defaultRateLimiter();
    for (let i = 0; i < 10; i++) rl.record('follow', 'alice.near');
    expect(rl.check('follow', 'alice.near').ok).toBe(false);
    jest.advanceTimersByTime(61_000);
    expect(rl.check('follow', 'alice.near').ok).toBe(true);
  });

  it('pins a threaded record to the authorizing window across a boundary', () => {
    const rl = defaultRateLimiter();
    // Advance to a clean state.
    jest.advanceTimersByTime(301_000);

    const check = rl.check('follow', 'bob.near');
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const authorizedWindow = check.window;

    // "Work" straddles the 60s window boundary — record lands after the
    // rollover but must pin back to the window the check authorized.
    jest.advanceTimersByTime(61_000);
    rl.record('follow', 'bob.near', authorizedWindow);

    // New window's budget is untouched because the record pinned to the
    // stale window and did not consume a slot in the current bucket.
    const fresh = rl.check('follow', 'bob.near');
    expect(fresh.ok).toBe(true);
  });

  it('drops a late record whose pinned window is older than the current entry', () => {
    const rl = defaultRateLimiter();
    jest.advanceTimersByTime(301_000);

    const first = rl.check('follow', 'carol.near');
    if (!first.ok) throw new Error('expected ok');
    rl.record('follow', 'carol.near', first.window);

    // Advance past the boundary, perform a fresh check+record in the new window.
    jest.advanceTimersByTime(61_000);
    const second = rl.check('follow', 'carol.near');
    if (!second.ok) throw new Error('expected ok');
    rl.record('follow', 'carol.near', second.window);

    // A late record pinned to the old window arrives after the new
    // entry has replaced the store — the late record is dropped rather
    // than polluting the current bucket.
    rl.record('follow', 'carol.near', first.window);

    // Consume the remaining 9 slots in the new window; the 10th record
    // should still fit (the late record was dropped, not counted here).
    for (let i = 0; i < 9; i++) {
      const ok = rl.check('follow', 'carol.near');
      expect(ok.ok).toBe(true);
      if (ok.ok) rl.record('follow', 'carol.near', ok.window);
    }
    // 11th exceeds the budget.
    expect(rl.check('follow', 'carol.near').ok).toBe(false);
  });

  it('isolates state per instance', () => {
    const a = defaultRateLimiter();
    const b = defaultRateLimiter();
    for (let i = 0; i < 10; i++) a.record('follow', 'alice.near');
    expect(a.check('follow', 'alice.near').ok).toBe(false);
    expect(b.check('follow', 'alice.near').ok).toBe(true);
  });

  it('check falls open for unknown actions (window stub is 0)', () => {
    // Current SDK behavior: unknown actions are not rate-limited. The
    // closed `MutationAction` union makes this unreachable from typed
    // call sites; the stub window is a compile-time satisfaction of
    // the `{ok: true, window}` shape.
    const rl = defaultRateLimiter();
    const result = rl.check('unknown_action', 'alice.near');
    expect(result).toEqual({ ok: true, window: 0 });
  });
});

describe('noopRateLimiter', () => {
  it('always returns ok', () => {
    const rl = noopRateLimiter();
    for (let i = 0; i < 1000; i++) {
      expect(rl.check('follow', 'alice.near').ok).toBe(true);
      rl.record('follow', 'alice.near');
    }
  });
});
