import {
  getBalance,
  InsufficientBalanceError,
  verifyWallet,
} from '../src/lib/outlayer';

function mockResponse(options: {
  status: number;
  body?: string;
  contentType?: string;
  textRejects?: boolean;
}): Response {
  const headers = new Headers();
  if (options.contentType) headers.set('content-type', options.contentType);
  return {
    ok: options.status >= 200 && options.status < 300,
    status: options.status,
    text: options.textRejects
      ? () => Promise.reject(new Error('body unavailable'))
      : () => Promise.resolve(options.body ?? ''),
    json: () => Promise.resolve(JSON.parse(options.body ?? '{}')),
    headers,
    clone: () => mockResponse(options),
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

describe('InsufficientBalanceError', () => {
  it('is an Error subclass with a distinguishable name', () => {
    const err = new InsufficientBalanceError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InsufficientBalanceError);
    expect(err.name).toBe('InsufficientBalanceError');
    expect(err.message).toMatch(/insufficient balance/i);
  });
});

describe('verifyWallet', () => {
  it('returns account_id and balance on a 200 response', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 200,
        body: JSON.stringify({
          account_id: 'alice.near',
          balance: '123',
        }),
        contentType: 'application/json',
      }),
    );
    const result = await verifyWallet('wk_abc');
    expect(result).toEqual({ account_id: 'alice.near', balance: '123' });
  });

  it('defaults balance to "0" when the response omits it', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 200,
        body: JSON.stringify({ account_id: 'alice.near' }),
        contentType: 'application/json',
      }),
    );
    const result = await verifyWallet('wk_abc');
    expect(result).toEqual({ account_id: 'alice.near', balance: '0' });
  });

  it('throws InsufficientBalanceError on 502 with text/html content-type', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 502,
        body: '<html><body>Bad Gateway</body></html>',
        contentType: 'text/html; charset=UTF-8',
      }),
    );
    await expect(verifyWallet('wk_abc')).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  });

  it('throws InsufficientBalanceError on 502 when body starts with < regardless of content-type', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 502,
        body: '<!doctype html><html>',
        contentType: 'text/plain',
      }),
    );
    await expect(verifyWallet('wk_abc')).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  });

  it('throws a generic Error (not InsufficientBalanceError) on 502 with non-HTML body', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 502,
        body: '{"error":"upstream_timeout"}',
        contentType: 'application/json',
      }),
    );
    const err = await verifyWallet('wk_abc').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InsufficientBalanceError);
    expect(String(err.message)).toContain('upstream_timeout');
  });

  it('throws "HTTP 502" when body reading rejects on a 502', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ status: 502, textRejects: true }),
    );
    const err = await verifyWallet('wk_abc').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InsufficientBalanceError);
    expect(err.message).toBe('HTTP 502');
  });

  it('falls through to assertOk for non-2xx non-502 (e.g. 401)', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 401,
        body: 'invalid_api_key',
      }),
    );
    const err = await verifyWallet('wk_bad').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InsufficientBalanceError);
  });

  it('throws when account_id is missing on a 200', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 200,
        body: JSON.stringify({ balance: '1' }),
        contentType: 'application/json',
      }),
    );
    await expect(verifyWallet('wk_abc')).rejects.toThrow(/no account_id/);
  });
});

describe('getBalance', () => {
  it('returns the balance string on a 200 response', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 200,
        body: JSON.stringify({ balance: '999' }),
        contentType: 'application/json',
      }),
    );
    const balance = await getBalance('wk_abc');
    expect(balance).toBe('999');
  });

  it('defaults to "0" when the response omits balance', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 200,
        body: '{}',
        contentType: 'application/json',
      }),
    );
    const balance = await getBalance('wk_abc');
    expect(balance).toBe('0');
  });

  it('throws InsufficientBalanceError on 502+HTML — symmetric with verifyWallet', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 502,
        body: '<html>Bad Gateway</html>',
        contentType: 'text/html',
      }),
    );
    await expect(getBalance('wk_abc')).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  });

  it('throws a generic Error on 502 with non-HTML body', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        status: 502,
        body: 'plain text outage notice',
        contentType: 'text/plain',
      }),
    );
    const err = await getBalance('wk_abc').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InsufficientBalanceError);
  });
});
