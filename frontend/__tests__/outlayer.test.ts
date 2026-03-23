import {
  registerOutlayer,
  signMessage,
} from '@/lib/outlayer';

// Mock fetch utilities
jest.mock('@/lib/fetch', () => {
  const errorText = async (res: Response) => {
    try { return await res.text(); } catch { return `HTTP ${res.status}`; }
  };
  return {
    fetchWithTimeout: jest.fn(),
    httpErrorText: jest.fn(errorText),
    assertOk: jest.fn(async (res: Response) => {
      if (!res.ok) throw new Error(await errorText(res));
    }),
  };
});

import { fetchWithTimeout } from '@/lib/fetch';

const mockFetch = fetchWithTimeout as jest.MockedFunction<
  typeof fetchWithTimeout
>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registerOutlayer', () => {
  it('registers and returns api_key and near_account_id', async () => {
    const responseData = {
      api_key: 'wk_new',
      near_account_id: 'user.near',
      handoff_url: 'https://outlayer.com/handoff',
      trial: true,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    } as Response);

    const { data, request } = await registerOutlayer();

    expect(data).toEqual(responseData);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/outlayer/register');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Service unavailable'),
    } as Response);

    await expect(registerOutlayer()).rejects.toThrow('Service unavailable');
  });

  it('handles unreadable error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('read failed')),
    } as Response);

    await expect(registerOutlayer()).rejects.toThrow('HTTP 502');
  });
});

describe('signMessage', () => {
  it('signs a message and returns NEP-413 components', async () => {
    const responseData = {
      account_id: 'user.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    } as Response);

    const { data, request } = await signMessage(
      'wk_key',
      '{"action":"register"}',
      'nearly.social',
    );

    expect(data).toEqual(responseData);
    expect(request.body).toEqual({
      message: '{"action":"register"}',
      recipient: 'nearly.social',
    });
    expect(request.headers.Authorization).toBe('Bearer wk_key');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid key'),
    } as Response);

    await expect(
      signMessage('wk_bad', 'msg', 'nearly.social'),
    ).rejects.toThrow('Invalid key');
  });
});

