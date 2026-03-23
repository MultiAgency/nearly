import { isRateLimited, checkRateLimit, getClientIp } from '@/lib/rate-limit';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('isRateLimited', () => {
  it('allows up to 60 requests in a window', () => {
    for (let i = 0; i < 60; i++) {
      expect(isRateLimited('10.0.0.1')).toBe(false);
    }
  });

  it('blocks on the 61st request', () => {
    for (let i = 0; i < 60; i++) {
      isRateLimited('10.0.0.2');
    }
    expect(isRateLimited('10.0.0.2')).toBe(true);
  });

  it('tracks IPs independently', () => {
    for (let i = 0; i < 60; i++) {
      isRateLimited('10.0.0.3');
    }
    expect(isRateLimited('10.0.0.3')).toBe(true);
    expect(isRateLimited('10.0.0.4')).toBe(false);
  });

  it('allows requests again after window slides', () => {
    for (let i = 0; i < 60; i++) {
      isRateLimited('10.0.0.5');
    }
    expect(isRateLimited('10.0.0.5')).toBe(true);

    // Advance past the 60-second window
    jest.advanceTimersByTime(61_000);

    expect(isRateLimited('10.0.0.5')).toBe(false);
  });

  it('triggers cleanup after a window cycle', () => {
    // Fill one IP to the limit
    for (let i = 0; i < 60; i++) {
      isRateLimited('10.0.0.6');
    }

    // Advance past the window so entries become stale
    jest.advanceTimersByTime(61_000);

    // Next call triggers cleanup; stale IP should be evicted and new request allowed
    expect(isRateLimited('10.0.0.7')).toBe(false);
  });
});

describe('checkRateLimit', () => {
  it('returns remaining count and resetAt', () => {
    const result = checkRateLimit('10.1.0.1');
    expect(result.limited).toBe(false);
    expect(result.remaining).toBe(59);
    expect(result.resetAt).toBeGreaterThan(0);
  });

  it('decrements remaining with each request', () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit('10.1.0.2');
    }
    const result = checkRateLimit('10.1.0.2');
    expect(result.remaining).toBe(49);
    expect(result.limited).toBe(false);
  });

  it('returns remaining=0 and limited=true at capacity', () => {
    for (let i = 0; i < 60; i++) {
      checkRateLimit('10.1.0.3');
    }
    const result = checkRateLimit('10.1.0.3');
    expect(result.limited).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('resetAt points to when the window slides', () => {
    const before = Date.now();
    checkRateLimit('10.1.0.4');
    const result = checkRateLimit('10.1.0.4');
    // resetAt should be ~60s from the first request
    expect(result.resetAt).toBeGreaterThanOrEqual(Math.ceil((before + 60_000) / 1000));
  });
});

describe('getClientIp', () => {
  function fakeRequest(headers: Record<string, string> = {}) {
    return { headers: new Headers(headers) } as unknown as Request;
  }

  it('extracts IP from single-value x-forwarded-for', () => {
    expect(getClientIp(fakeRequest({ 'x-forwarded-for': '1.2.3.4' }))).toBe('1.2.3.4');
  });

  it('prefers x-forwarded-for over x-real-ip', () => {
    expect(getClientIp(fakeRequest({
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '9.8.7.6',
    }))).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip', () => {
    expect(getClientIp(fakeRequest({ 'x-real-ip': '9.8.7.6' }))).toBe('9.8.7.6');
  });

  it('defaults to 127.0.0.1 when no headers present', () => {
    expect(getClientIp(fakeRequest())).toBe('127.0.0.1');
  });

  it('uses rightmost IP from multi-value x-forwarded-for', () => {
    // The implementation trusts the rightmost entry (appended by trusted proxy)
    const headers = new Headers();
    headers.set('x-forwarded-for', '10.0.0.1, 192.168.1.1, 5.6.7.8');
    const req = { headers } as unknown as Request;
    expect(getClientIp(req)).toBe('5.6.7.8');
  });
});
