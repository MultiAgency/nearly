import { buildClaim, verifyClaim } from '../src/claim';
import type { FetchLike } from '../src/read';
import { jsonResponse } from './fixtures/http';

describe('buildClaim', () => {
  it('produces canonical JSON key order', () => {
    const now = Date.now();
    const json = buildClaim({
      action: 'get_vrf_seed',
      accountId: 'alice.near',
      domain: 'nearly.social',
      version: 1,
    });
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual([
      'action',
      'domain',
      'account_id',
      'version',
      'timestamp',
    ]);
    expect(parsed.action).toBe('get_vrf_seed');
    expect(parsed.domain).toBe('nearly.social');
    expect(parsed.account_id).toBe('alice.near');
    expect(parsed.version).toBe(1);
    expect(parsed.timestamp).toBeGreaterThanOrEqual(now);
  });

  it('uses camelCase accountId → snake_case account_id', () => {
    const parsed = JSON.parse(
      buildClaim({
        action: 'test',
        accountId: 'bob.near',
        domain: 'd',
        version: 2,
      }),
    );
    expect(parsed.account_id).toBe('bob.near');
    expect(parsed).not.toHaveProperty('accountId');
  });
});

describe('verifyClaim', () => {
  const claim = {
    account_id: 'alice.near',
    public_key: 'ed25519:abc',
    signature: 'sig123',
    nonce: 'bm9uY2U=',
    message: '{"action":"test"}',
  };

  it('returns structured success response', async () => {
    const body = {
      valid: true,
      account_id: 'alice.near',
      public_key: 'ed25519:abc',
      recipient: 'nearly.social',
      nonce: 'bm9uY2U=',
      message: { action: 'test', timestamp: 1700000000 },
      verified_at: 1700000000,
    };
    const fetch: FetchLike = async () => jsonResponse(body);
    const result = await verifyClaim(claim, {
      url: 'https://example.com/verify',
      recipient: 'nearly.social',
      fetch,
    });
    expect(result).toEqual(body);
  });

  it('returns structured failure (valid: false)', async () => {
    const body = { valid: false, reason: 'expired', detail: 'stale timestamp' };
    const fetch: FetchLike = async () => jsonResponse(body);
    const result = await verifyClaim(claim, {
      url: 'https://example.com/verify',
      recipient: 'nearly.social',
      fetch,
    });
    expect(result.valid).toBe(false);
  });

  it('passes 502 through as structured response (VRF upstream error)', async () => {
    const body = { valid: false, reason: 'rpc_error', detail: 'upstream 502' };
    const fetch: FetchLike = async () => jsonResponse(body, 502);
    const result = await verifyClaim(claim, {
      url: 'https://example.com/verify',
      recipient: 'nearly.social',
      fetch,
    });
    expect(result.valid).toBe(false);
  });

  it('throws PROTOCOL on non-2xx non-502 response', async () => {
    const fetch: FetchLike = async () =>
      new Response('server error', { status: 500 });
    await expect(
      verifyClaim(claim, {
        url: 'https://example.com/verify',
        recipient: 'nearly.social',
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws PROTOCOL on malformed JSON response', async () => {
    const fetch: FetchLike = async () =>
      new Response('not json', { status: 200 });
    await expect(
      verifyClaim(claim, {
        url: 'https://example.com/verify',
        recipient: 'nearly.social',
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws PROTOCOL when response missing valid field', async () => {
    const fetch: FetchLike = async () =>
      jsonResponse({ account_id: 'alice.near' });
    await expect(
      verifyClaim(claim, {
        url: 'https://example.com/verify',
        recipient: 'nearly.social',
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws NETWORK on fetch failure', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('connection refused');
    };
    await expect(
      verifyClaim(claim, {
        url: 'https://example.com/verify',
        recipient: 'nearly.social',
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('sends expectedDomain when provided', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetch: FetchLike = async (_url, init) => {
      sentBody = JSON.parse(init?.body as string);
      return jsonResponse({
        valid: true,
        account_id: 'alice.near',
        public_key: 'ed25519:abc',
        recipient: 'nearly.social',
        nonce: 'bm9uY2U=',
        message: { timestamp: 1 },
        verified_at: 1,
      });
    };
    await verifyClaim(claim, {
      url: 'https://example.com/verify',
      recipient: 'nearly.social',
      expectedDomain: 'nearly.social',
      fetch,
    });
    expect(sentBody.expected_domain).toBe('nearly.social');
  });

  it('omits expected_domain when not provided', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetch: FetchLike = async (_url, init) => {
      sentBody = JSON.parse(init?.body as string);
      return jsonResponse({
        valid: true,
        account_id: 'alice.near',
        public_key: 'ed25519:abc',
        recipient: 'nearly.social',
        nonce: 'bm9uY2U=',
        message: { timestamp: 1 },
        verified_at: 1,
      });
    };
    await verifyClaim(claim, {
      url: 'https://example.com/verify',
      recipient: 'nearly.social',
      fetch,
    });
    expect(sentBody).not.toHaveProperty('expected_domain');
  });
});
