import {
  batchCreatePaymentChecks,
  claimPaymentCheck,
  createDepositIntent,
  createPaymentCheck,
  createSubAgentKey,
  getBalance,
  getDepositStatus,
  getPaymentCheckStatus,
  listDeposits,
  listPaymentChecks,
  peekPaymentCheck,
  reclaimPaymentCheck,
  registerOutlayer,
  registerOutlayerDeterministic,
  revokeSubAgentKey,
  signMessage,
} from '@/lib/outlayer';

jest.mock('@/lib/fetch', () => {
  const errorText = async (res: Response) => {
    try {
      return await res.text();
    } catch {
      return `HTTP ${res.status}`;
    }
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

    const result = await registerOutlayer();

    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/register',
      expect.objectContaining({ method: 'POST' }),
      10_000,
    );
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

describe('registerOutlayerDeterministic', () => {
  const params = {
    account_id: 'alice.near',
    seed: 'my-app-seed',
    pubkey: 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp',
    message: 'register:my-app-seed:1712345678',
    signature: '5UAy1L7P9NhK3GQDXmGpHxW2tLFR1DnA7k7Gp1XVLUqE',
  };

  it('sends deterministic registration fields in body', async () => {
    const responseData = {
      near_account_id: 'abc123hex',
      trial: { calls_remaining: 100, expires_at: '2026-05-04T00:00:00Z' },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    } as Response);

    const result = await registerOutlayerDeterministic(params);

    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(params),
      }),
      10_000,
    );
  });

  it('response does not include api_key', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          near_account_id: 'abc123hex',
          trial: { calls_remaining: 100, expires_at: '2026-05-04T00:00:00Z' },
        }),
    } as Response);

    const result = await registerOutlayerDeterministic(params);
    expect(result).not.toHaveProperty('api_key');
  });

  it('throws on invalid signature', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid_signature'),
    } as Response);

    await expect(registerOutlayerDeterministic(params)).rejects.toThrow(
      'invalid_signature',
    );
  });
});

describe('signMessage', () => {
  it('signs a message and returns NEP-413 components', async () => {
    const responseData = {
      account_id: 'user.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      signature_base64: 'c2ln',
      nonce: 'bm9uY2U=',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    } as Response);

    const result = await signMessage(
      'wk_key',
      '{"action":"register"}',
      'nearly.social',
    );

    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/sign-message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer wk_key',
        }),
        body: JSON.stringify({
          message: '{"action":"register"}',
          recipient: 'nearly.social',
        }),
      }),
      10_000,
    );
  });

  it('omits format from body when not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          account_id: 'a',
          public_key: 'k',
          signature: 's',
          signature_base64: 'b',
          nonce: 'n',
        }),
    } as Response);

    await signMessage('wk_key', 'msg', 'nearly.social');

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ message: 'msg', recipient: 'nearly.social' });
    expect(body.format).toBeUndefined();
  });

  it('includes format in body when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          account_id: 'a',
          public_key: 'k',
          signature: 'rawsig',
          signature_base64: 'cmF3c2ln',
          nonce: '',
        }),
    } as Response);

    const result = await signMessage('wk_key', 'msg', 'nearly.social', 'raw');

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.format).toBe('raw');
    expect(result.signature_base64).toBe('cmF3c2ln');
    expect(result.nonce).toBe('');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid key'),
    } as Response);

    await expect(signMessage('wk_bad', 'msg', 'nearly.social')).rejects.toThrow(
      'Invalid key',
    );
  });
});

describe('timeout configuration', () => {
  it('passes API_TIMEOUT_MS to all fetchWithTimeout calls', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          api_key: 'wk_x',
          near_account_id: 'x.near',
          handoff_url: '',
          trial: true,
        }),
    } as Response);

    await registerOutlayer();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      10_000,
    );

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          account_id: 'x.near',
          public_key: 'ed25519:a',
          signature: 'ed25519:s',
          signature_base64: 'c2ln',
          nonce: 'bm9uY2U=',
        }),
    } as Response);

    await signMessage('wk_key', 'msg', 'nearly.social');
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      10_000,
    );

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ balance: '1' }),
    } as Response);

    await getBalance('wk_key');
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      10_000,
    );
  });
});

describe('getBalance', () => {
  it('returns balance on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ balance: '12.5' }),
    } as Response);

    const balance = await getBalance('wk_key');
    expect(balance).toBe('12.5');
  });

  it('returns 0 when balance field is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const balance = await getBalance('wk_key');
    expect(balance).toBe('0');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as unknown as Response);

    await expect(getBalance('wk_bad')).rejects.toThrow('Unauthorized');
  });

  it('throws on non-JSON response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('not JSON')),
    } as Response);

    await expect(getBalance('wk_key')).rejects.toThrow('unexpected response');
  });
});

describe('createSubAgentKey', () => {
  it('sends PUT with seed and key_hash', async () => {
    const resp = { wallet_id: 'uuid', near_account_id: 'hex64' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(resp),
    } as Response);

    const result = await createSubAgentKey('wk_parent', {
      seed: 'sub-task',
      key_hash: 'abc123',
    });

    expect(result).toEqual(resp);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/api-key',
      expect.objectContaining({ method: 'PUT' }),
      10_000,
    );
  });
});

describe('revokeSubAgentKey', () => {
  it('sends DELETE with key hash in path', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    await revokeSubAgentKey('wk_parent', 'abc123hash');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/api-key/abc123hash',
      expect.objectContaining({ method: 'DELETE' }),
      10_000,
    );
  });

  it('throws on 409 conflict (last key)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve('conflict'),
    } as Response);

    await expect(revokeSubAgentKey('wk_parent', 'last')).rejects.toThrow(
      'conflict',
    );
  });
});

describe('createDepositIntent', () => {
  it('sends POST with chain and amount', async () => {
    const resp = {
      intent_id: 'uuid',
      deposit_address: 'sol_addr',
      amount: '1000000',
      amount_out: '999998',
      min_amount_out: '989998',
      expires_at: '2026-04-10T00:00:00Z',
      estimated_time_secs: 20,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(resp),
    } as Response);

    const result = await createDepositIntent('wk_key', {
      chain: 'solana',
      amount: '1000000',
      token: 'USDC',
    });

    expect(result).toEqual(resp);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/deposit-intent',
      expect.objectContaining({ method: 'POST' }),
      10_000,
    );
  });
});

describe('getDepositStatus', () => {
  it('passes intent_id as query param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'bridging' }),
    } as Response);

    const result = await getDepositStatus('wk_key', 'uuid-123');

    expect(result.status).toBe('bridging');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/deposit-status?id=uuid-123',
      expect.any(Object),
      10_000,
    );
  });
});

describe('listDeposits', () => {
  it('passes limit as query param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deposits: [] }),
    } as Response);

    await listDeposits('wk_key', 10);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/deposits?limit=10',
      expect.any(Object),
      10_000,
    );
  });
});

describe('payment checks', () => {
  it('createPaymentCheck sends correct body', async () => {
    const resp = {
      request_id: 'uuid',
      status: 'success',
      check_id: 'pc_123',
      check_key: 'ed25519:key',
      token: 'usdc',
      amount: '1000000',
      created_at: '2026-04-04T00:00:00Z',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(resp),
    } as Response);

    const result = await createPaymentCheck('wk_key', {
      token: 'usdc',
      amount: '1000000',
      memo: 'test',
      expires_in: 86400,
    });

    expect(result.check_id).toBe('pc_123');
    expect(result.check_key).toBe('ed25519:key');
  });

  it('batchCreatePaymentChecks sends checks array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ checks: [] }),
    } as Response);

    await batchCreatePaymentChecks('wk_key', [
      { token: 'usdc', amount: '500000' },
      { token: 'usdc', amount: '500000' },
    ]);

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.checks).toHaveLength(2);
  });

  it('claimPaymentCheck supports partial claim with amount', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          request_id: 'uuid',
          status: 'success',
          token: 'usdc',
          amount_claimed: '500000',
          remaining: '500000',
          claimed_at: '2026-04-04T00:00:00Z',
          intent_hash: 'abc',
        }),
    } as Response);

    const result = await claimPaymentCheck('wk_key', 'ed25519:key', '500000');

    expect(result.amount_claimed).toBe('500000');
    expect(result.remaining).toBe('500000');
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.amount).toBe('500000');
    expect(body.check_key).toBe('ed25519:key');
  });

  it('claimPaymentCheck omits amount for full claim', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          request_id: 'uuid',
          status: 'success',
          token: 'usdc',
          amount_claimed: '1000000',
          remaining: '0',
          claimed_at: '2026-04-04T00:00:00Z',
          intent_hash: 'abc',
        }),
    } as Response);

    await claimPaymentCheck('wk_key', 'ed25519:key');

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.amount).toBeUndefined();
  });

  it('reclaimPaymentCheck supports partial reclaim', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          request_id: 'uuid',
          status: 'success',
          token: 'usdc',
          amount_reclaimed: '300000',
          remaining: '200000',
          reclaimed_at: '2026-04-04T00:00:00Z',
          intent_hash: 'def',
        }),
    } as Response);

    const result = await reclaimPaymentCheck('wk_key', 'pc_123', '300000');

    expect(result.amount_reclaimed).toBe('300000');
    expect(result.remaining).toBe('200000');
  });

  it('peekPaymentCheck returns balance and status', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          token: 'usdc',
          balance: '500000',
          status: 'partially_claimed',
        }),
    } as Response);

    const result = await peekPaymentCheck('wk_key', 'ed25519:key');

    expect(result.balance).toBe('500000');
    expect(result.status).toBe('partially_claimed');
  });

  it('getPaymentCheckStatus returns full status', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          check_id: 'pc_123',
          token: 'usdc',
          amount: '1000000',
          claimed_amount: '500000',
          reclaimed_amount: '0',
          status: 'partially_claimed',
          created_at: '2026-04-04T00:00:00Z',
        }),
    } as Response);

    const result = await getPaymentCheckStatus('wk_key', 'pc_123');

    expect(result.status).toBe('partially_claimed');
    expect(result.claimed_amount).toBe('500000');
  });

  it('listPaymentChecks passes status and limit params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ checks: [] }),
    } as Response);

    await listPaymentChecks('wk_key', { status: 'unclaimed', limit: 50 });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/payment-check/list?status=unclaimed&limit=50',
      expect.any(Object),
      10_000,
    );
  });
});
