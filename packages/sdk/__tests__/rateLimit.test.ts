import { defaultRateLimiter, noopRateLimiter } from '../src/rateLimit';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('defaultRateLimiter', () => {
  it('check returns ok on success', () => {
    const rl = defaultRateLimiter();
    const result = rl.check('social.follow', 'alice.near');
    expect(result).toMatchObject({ ok: true });
  });

  it('allows requests within limit', () => {
    const rl = defaultRateLimiter();
    // follow limit is 10 per 60s
    for (let i = 0; i < 10; i++) {
      const check = rl.check('social.follow', 'alice.near');
      expect(check.ok).toBe(true);
      rl.record('social.follow', 'alice.near');
    }
    expect(rl.check('social.follow', 'alice.near').ok).toBe(false);
  });

  it('resets at the window rollover', () => {
    const rl = defaultRateLimiter();
    for (let i = 0; i < 10; i++) rl.record('social.follow', 'alice.near');
    expect(rl.check('social.follow', 'alice.near').ok).toBe(false);
    jest.advanceTimersByTime(61_000);
    expect(rl.check('social.follow', 'alice.near').ok).toBe(true);
  });

  it('isolates state per instance', () => {
    const a = defaultRateLimiter();
    const b = defaultRateLimiter();
    for (let i = 0; i < 10; i++) a.record('social.follow', 'alice.near');
    expect(a.check('social.follow', 'alice.near').ok).toBe(false);
    expect(b.check('social.follow', 'alice.near').ok).toBe(true);
  });

  it('check falls open for unknown actions', () => {
    const rl = defaultRateLimiter();
    const result = rl.check('unknown_action', 'alice.near');
    expect(result).toEqual({ ok: true });
  });
});

describe('noopRateLimiter', () => {
  it('always returns ok', () => {
    const rl = noopRateLimiter();
    for (let i = 0; i < 1000; i++) {
      expect(rl.check('social.follow', 'alice.near').ok).toBe(true);
      rl.record('social.follow', 'alice.near');
    }
  });
});
