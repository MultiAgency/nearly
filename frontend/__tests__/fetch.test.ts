import {
  assertOk,
  fetchWithRetry,
  fetchWithTimeout,
  httpErrorText,
} from '../src/lib/fetch';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(body: string, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
    headers: new Headers(),
    clone: () => mockResponse(body, status),
  } as unknown as Response;
}

const originalFetch = global.fetch;
let mockFetch: jest.Mock;

beforeEach(() => {
  mockFetch = jest.fn();
  global.fetch = mockFetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

describe('fetchWithTimeout', () => {
  it('returns a successful response within the timeout', async () => {
    mockFetch.mockResolvedValue(mockResponse('ok', 200));

    const res = await fetchWithTimeout('https://example.com');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('passes options through to fetch', async () => {
    mockFetch.mockResolvedValue(mockResponse('', 200));

    await fetchWithTimeout('https://example.com', {
      method: 'POST',
      headers: { 'X-Test': '1' },
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['X-Test']).toBe('1');
  });

  it('aborts when the timeout elapses', async () => {
    jest.useFakeTimers();

    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    const promise = fetchWithTimeout('https://example.com', undefined, 50);
    jest.advanceTimersByTime(50);

    await expect(promise).rejects.toThrow('aborted');
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

describe('fetchWithRetry', () => {
  it('returns immediately on a 2xx response', async () => {
    mockFetch.mockResolvedValue(mockResponse('ok', 200));

    const res = await fetchWithRetry('https://example.com');
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on a 4xx response (no retry)', async () => {
    mockFetch.mockResolvedValue(mockResponse('bad', 400));

    const res = await fetchWithRetry('https://example.com');
    expect(res.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse('err', 502))
      .mockResolvedValueOnce(mockResponse('ok', 200));

    const res = await fetchWithRetry('https://example.com');
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns the last 5xx response after exhausting retries', async () => {
    mockFetch.mockResolvedValue(mockResponse('err', 500));

    const res = await fetchWithRetry('https://example.com');
    expect(res.status).toBe(500);
  });

  it('retries on network error then succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(mockResponse('ok', 200));

    const res = await fetchWithRetry('https://example.com');
    expect(res.status).toBe(200);
  });

  it('throws after exhausting retries on network error', async () => {
    mockFetch.mockRejectedValue(new Error('network'));

    await expect(fetchWithRetry('https://example.com')).rejects.toThrow(
      'network',
    );
  });
});

// ---------------------------------------------------------------------------
// httpErrorText
// ---------------------------------------------------------------------------

describe('httpErrorText', () => {
  it('extracts error string from JSON body', async () => {
    const res = mockResponse(JSON.stringify({ error: 'not found' }), 404);
    expect(await httpErrorText(res)).toBe('not found');
  });

  it('returns raw text when JSON has no error field', async () => {
    const res = mockResponse(JSON.stringify({ ok: false }), 400);
    expect(await httpErrorText(res)).toBe('{"ok":false}');
  });

  it('returns raw text for non-JSON body', async () => {
    const res = mockResponse('Bad Request', 400);
    expect(await httpErrorText(res)).toBe('Bad Request');
  });

  it('falls back to HTTP status when text() throws', async () => {
    const res = {
      ok: false,
      status: 503,
      text: () => Promise.reject(new Error('stream error')),
    } as unknown as Response;
    expect(await httpErrorText(res)).toBe('HTTP 503');
  });
});

// ---------------------------------------------------------------------------
// assertOk
// ---------------------------------------------------------------------------

describe('assertOk', () => {
  it('passes through on an ok response', async () => {
    const res = mockResponse('ok', 200);
    await expect(assertOk(res)).resolves.toBeUndefined();
  });

  it('throws with error text on a non-ok response', async () => {
    const res = mockResponse('forbidden', 403);
    await expect(assertOk(res)).rejects.toThrow('forbidden');
  });
});
