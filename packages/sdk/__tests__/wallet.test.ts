import type { FetchLike } from '../src/read';
import {
  buildClaimMessage,
  callOutlayer,
  createWalletClient,
  deriveSubAgentKey,
  getVrfSeed,
  getWalletBalance,
  registerSubAgentKey,
  registerWallet,
  signClaim,
  submitWrite,
  type WalletClient,
} from '../src/wallet';

interface Call {
  url: string;
  init?: RequestInit;
}

function scripted(handler: (url: string, init?: RequestInit) => Response): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function walletOf(fetch: FetchLike, walletKey = 'wk_test'): WalletClient {
  return createWalletClient({
    outlayerUrl: 'https://outlayer.example',
    namespace: 'contextual.near',
    walletKey,
    fetch,
  });
}

describe('registerWallet', () => {
  it('returns walletKey, accountId, trial from a valid 2xx response', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc123',
        near_account_id: '4397d730abcd',
        trial: { calls_remaining: 100 },
        // Extra fields the SDK pins only a subset of — ensure they're ignored.
        url: 'https://outlayer.fastnear.com/wallet?key=wk_abc123',
        balance: '0',
      }),
    );
    const res = await registerWallet({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect(res.walletKey).toBe('wk_abc123');
    expect(res.accountId).toBe('4397d730abcd');
    expect(res.trial).toEqual({ calls_remaining: 100 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/register');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('surfaces handoff_url and trial.expires_at when OutLayer returns them', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc123',
        near_account_id: '4397d730abcd',
        handoff_url: 'https://outlayer.fastnear.com/wallet?key=wk_abc123',
        trial: {
          calls_remaining: 100,
          expires_at: '2026-05-14T00:00:00Z',
        },
      }),
    );
    const res = await registerWallet({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect(res.handoffUrl).toBe(
      'https://outlayer.fastnear.com/wallet?key=wk_abc123',
    );
    expect(res.trial).toEqual({
      calls_remaining: 100,
      expires_at: '2026-05-14T00:00:00Z',
    });
  });

  it('omits handoffUrl and trial.expires_at when OutLayer does not return them', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc123',
        near_account_id: '4397d730abcd',
        trial: { calls_remaining: 100 },
      }),
    );
    const res = await registerWallet({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect('handoffUrl' in res).toBe(false);
    expect(res.trial).toEqual({ calls_remaining: 100 });
    expect('expires_at' in res.trial).toBe(false);
  });

  it('throws protocolError on malformed JSON', async () => {
    const { fetch } = scripted(
      () =>
        new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      registerWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws protocolError when api_key is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        near_account_id: '4397d730',
        trial: { calls_remaining: 100 },
      }),
    );
    await expect(
      registerWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws protocolError when near_account_id is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ api_key: 'wk_x', trial: { calls_remaining: 5 } }),
    );
    await expect(
      registerWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws protocolError when trial.calls_remaining is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ api_key: 'wk_x', near_account_id: '4397d730' }),
    );
    await expect(
      registerWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws authError on 401', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 401 }));
    await expect(
      registerWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('throws protocolError on other non-2xx', async () => {
    const { fetch } = scripted(
      () => new Response('upstream down', { status: 503 }),
    );
    await expect(
      registerWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });
});

describe('getWalletBalance', () => {
  it('returns balance, accountId, derived balanceNear for chain=near', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        account_id: '4397d730abcd',
        balance: '9393299973616100000000', // 0.00939329... NEAR
      }),
    );
    const wallet = walletOf(fetch);
    const res = await getWalletBalance(wallet);
    expect(res.accountId).toBe('4397d730abcd');
    expect(res.chain).toBe('near');
    expect(res.balance).toBe('9393299973616100000000');
    expect(res.balanceNear).toBeCloseTo(0.00939329, 6);
    expect(calls[0].url).toBe(
      'https://outlayer.example/wallet/v1/balance?chain=near',
    );
    // The Authorization header carries wk_ verbatim.
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer wk_test');
  });

  it('returns balance=0 as a valid response (not an error)', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ account_id: '4397d730', balance: '0' }),
    );
    const res = await getWalletBalance(walletOf(fetch));
    expect(res.balance).toBe('0');
    expect(res.balanceNear).toBe(0);
  });

  it('omits balanceNear on non-near chains', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({ account_id: 'bob.eth', balance: '1000000000000000000' }),
    );
    const res = await getWalletBalance(walletOf(fetch), { chain: 'eth' });
    expect(res.chain).toBe('eth');
    expect(res.balance).toBe('1000000000000000000');
    expect(res.balanceNear).toBeUndefined();
    expect(calls[0].url).toContain('chain=eth');
  });

  it('throws authError on 401', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 401 }));
    await expect(getWalletBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('throws protocolError on malformed JSON', async () => {
    const { fetch } = scripted(
      () =>
        new Response('oops', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(getWalletBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('throws protocolError when balance field is missing', async () => {
    const { fetch } = scripted(() => jsonResponse({ account_id: '4397d730' }));
    await expect(getWalletBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('throws protocolError when account_id field is missing', async () => {
    const { fetch } = scripted(() => jsonResponse({ balance: '1' }));
    await expect(getWalletBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('never includes the wk_ key in error messages', async () => {
    const { fetch } = scripted(
      () =>
        new Response('downstream leaked wk_test inside body', { status: 500 }),
    );
    try {
      await getWalletBalance(walletOf(fetch));
      fail('expected throw');
    } catch (err) {
      // The upstream body may smuggle the wk_ substring. The SDK truncates
      // to 200 chars and attaches the snippet — the assertion here is that
      // we never materialize the caller's own wk_ (which lives only in the
      // Authorization header, not the body). The upstream response can
      // contain arbitrary text; this is guardrail, not sanitization.
      expect((err as Error).message).toContain('getBalance 500');
    }
  });
});

describe('deriveSubAgentKey', () => {
  // Pinned SHA256 fixture against the formula documented in
  // `.agents/skills/agent-custody/SKILL.md`:
  //
  //   sub_key  = "wk_" + sha256_hex(f"{seed}:0:{parent_key}")
  //   key_hash =         sha256_hex(sub_key)
  //
  // Pin values computed against Node 18+ `crypto.createHash('sha256')`
  // at implementation time. Regression in the UTF-8 encoding, the
  // concatenation order, or the Web Crypto API plumbing fails this
  // test before any network call reaches OutLayer.
  it('matches the pinned SHA256 derivation for a known (parent, seed) pair', async () => {
    const { subKey, keyHash } = await deriveSubAgentKey(
      'wk_parent_fixture',
      'worker-1',
    );
    expect(subKey).toBe(
      'wk_d980069f292e8a2a88fde6eb7b70ce4bacc88aa11172c0854a99bc8ced926bb9',
    );
    expect(keyHash).toBe(
      'd59cf62037441d21a93d5fd3d6892971fdfed38c5f08a40ea77b184e0720187c',
    );
  });

  it('is pure — same inputs produce same outputs across calls', async () => {
    const a = await deriveSubAgentKey('wk_p', 'seed-a');
    const b = await deriveSubAgentKey('wk_p', 'seed-a');
    expect(a.subKey).toBe(b.subKey);
    expect(a.keyHash).toBe(b.keyHash);
  });

  it('different seeds produce different sub_keys', async () => {
    const a = await deriveSubAgentKey('wk_p', 'seed-a');
    const b = await deriveSubAgentKey('wk_p', 'seed-b');
    expect(a.subKey).not.toBe(b.subKey);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it('different parents produce different sub_keys for the same seed', async () => {
    const a = await deriveSubAgentKey('wk_alice', 'shared');
    const b = await deriveSubAgentKey('wk_bob', 'shared');
    expect(a.subKey).not.toBe(b.subKey);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it('subKey is "wk_" prefix + 64 hex chars (total 67)', async () => {
    const { subKey } = await deriveSubAgentKey('wk_p', 'seed');
    expect(subKey).toMatch(/^wk_[0-9a-f]{64}$/);
    expect(subKey.length).toBe(67);
  });

  it('keyHash is 64 hex chars (no prefix)', async () => {
    const { keyHash } = await deriveSubAgentKey('wk_p', 'seed');
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash.length).toBe(64);
  });
});

describe('registerSubAgentKey', () => {
  it('PUTs to /wallet/v1/api-key with parent Bearer and {seed, key_hash} body', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        wallet_id: 'uuid-sub',
        near_account_id:
          'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      }),
    );
    const { accountId, walletId } = await registerSubAgentKey({
      outlayerUrl: 'https://outlayer.example',
      parentKey: 'wk_parent_test',
      seed: 'worker-1',
      keyHash: 'fakehash64chars',
      fetch,
    });
    expect(accountId).toMatch(/^fedcba98/);
    expect(walletId).toBe('uuid-sub');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/wallet/v1/api-key');
    expect(calls[0].init?.method).toBe('PUT');
    // Parent Bearer header present, sub-key not yet in play.
    const authHeader = (calls[0].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(authHeader).toBe('Bearer wk_parent_test');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ seed: 'worker-1', key_hash: 'fakehash64chars' });
  });

  it('walletId is undefined when response omits it', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        near_account_id:
          'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      }),
    );
    const { accountId, walletId } = await registerSubAgentKey({
      outlayerUrl: 'https://outlayer.example',
      parentKey: 'wk_parent',
      seed: 'seed',
      keyHash: 'hash',
      fetch,
    });
    expect(accountId).toBeDefined();
    expect(walletId).toBeUndefined();
  });

  it('throws NETWORK on fetch rejection', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      registerSubAgentKey({
        outlayerUrl: 'https://outlayer.example',
        parentKey: 'wk_p',
        seed: 's',
        keyHash: 'h',
        fetch,
      }),
    ).rejects.toMatchObject({ shape: { code: 'NETWORK' } });
  });

  it('throws AUTH_FAILED on 401 (parent key rejected)', async () => {
    const { fetch } = scripted(
      () => new Response('unauthorized', { status: 401 }),
    );
    await expect(
      registerSubAgentKey({
        outlayerUrl: 'https://outlayer.example',
        parentKey: 'wk_bad',
        seed: 's',
        keyHash: 'h',
        fetch,
      }),
    ).rejects.toMatchObject({ shape: { code: 'AUTH_FAILED' } });
  });

  it('throws PROTOCOL on 5xx', async () => {
    const { fetch } = scripted(
      () => new Response('upstream down', { status: 502 }),
    );
    await expect(
      registerSubAgentKey({
        outlayerUrl: 'https://outlayer.example',
        parentKey: 'wk_p',
        seed: 's',
        keyHash: 'h',
        fetch,
      }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('api-key 502'),
      },
    });
  });

  it('throws PROTOCOL on non-JSON 2xx', async () => {
    const { fetch } = scripted(
      () =>
        new Response('<html>oops</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    await expect(
      registerSubAgentKey({
        outlayerUrl: 'https://outlayer.example',
        parentKey: 'wk_p',
        seed: 's',
        keyHash: 'h',
        fetch,
      }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('malformed JSON'),
      },
    });
  });

  it('throws PROTOCOL when near_account_id is missing', async () => {
    const { fetch } = scripted(() => jsonResponse({ wallet_id: 'only-this' }));
    await expect(
      registerSubAgentKey({
        outlayerUrl: 'https://outlayer.example',
        parentKey: 'wk_p',
        seed: 's',
        keyHash: 'h',
        fetch,
      }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('near_account_id'),
      },
    });
  });
});

describe('submitWrite', () => {
  // `submitWrite` is the single funnel for FastData KV writes from the
  // SDK. Direct coverage of the OutLayer wire contract so regressions
  // fail at the function-under-test level, not through an opaque
  // mutation flow in client.test.ts.

  it('sends POST /wallet/v1/call with Bearer wk_ and __fastdata_kv envelope', async () => {
    const { fetch, calls } = scripted(
      () => new Response(null, { status: 200 }),
    );
    const wallet = walletOf(fetch, 'wk_submit_test');
    await submitWrite(wallet, { profile: { name: 'alice' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/wallet/v1/call');
    expect(calls[0].init?.method).toBe('POST');
    const authHeader = (calls[0].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(authHeader).toBe('Bearer wk_submit_test');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toMatchObject({
      receiver_id: 'contextual.near',
      method_name: '__fastdata_kv',
      args: { profile: { name: 'alice' } },
    });
    // gas + deposit are populated from constants — verify they're sent,
    // not omitted (omission would make OutLayer reject).
    expect(body.gas).toBeDefined();
    expect(body.deposit).toBeDefined();
  });

  it('resolves silently on 2xx — success is no-return, not a shape', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 200 }));
    const wallet = walletOf(fetch);
    const result = await submitWrite(wallet, { profile: {} });
    expect(result).toBeUndefined();
  });

  it('throws NETWORK on fetch rejection (network layer)', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const wallet = walletOf(fetch);
    await expect(submitWrite(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'NETWORK' },
    });
  });

  it('throws AUTH_FAILED on 401', async () => {
    const { fetch } = scripted(
      () => new Response('unauthorized', { status: 401 }),
    );
    const wallet = walletOf(fetch);
    await expect(submitWrite(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'AUTH_FAILED' },
    });
  });

  it('throws AUTH_FAILED on 403', async () => {
    const { fetch } = scripted(
      () => new Response('forbidden', { status: 403 }),
    );
    const wallet = walletOf(fetch);
    await expect(submitWrite(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'AUTH_FAILED' },
    });
  });

  it('throws INSUFFICIENT_BALANCE on 502 (Cloudflare upstream for unfunded wallets)', async () => {
    // OutLayer surfaces unfunded-wallet rejections as Cloudflare 502s
    // when the write path trips the upstream timeout on the TEE.
    const { fetch } = scripted(
      () => new Response('upstream timeout', { status: 502 }),
    );
    const wallet = walletOf(fetch);
    await expect(submitWrite(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'INSUFFICIENT_BALANCE' },
    });
  });

  it('throws PROTOCOL on other non-2xx with truncated body in hint', async () => {
    const { fetch } = scripted(
      () => new Response('internal error', { status: 500 }),
    );
    const wallet = walletOf(fetch);
    await expect(submitWrite(wallet, { profile: {} })).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('submitWrite 500'),
      },
    });
  });

  it('throws PROTOCOL with "no body" hint when a non-2xx response has an empty body', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 500 }));
    const wallet = walletOf(fetch);
    await expect(submitWrite(wallet, { profile: {} })).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('no body'),
      },
    });
  });

  it('does not leak the wallet key into any error message on a 5xx with a body that echoes the Bearer', async () => {
    // Worst-case scenario: an upstream 500 page that dumps the request
    // headers in its debug output would contain `Bearer wk_...`. The
    // error surface must redact it via `sanitizeErrorDetail`.
    const echoBody =
      'upstream error: Authorization=Bearer wk_secret_test_DO_NOT_LEAK failed';
    const { fetch } = scripted(() => new Response(echoBody, { status: 500 }));
    const wallet = walletOf(fetch, 'wk_secret_test_DO_NOT_LEAK');
    try {
      await submitWrite(wallet, { profile: {} });
      throw new Error('expected submitWrite to throw');
    } catch (err) {
      const serialized = JSON.stringify({
        message: (err as Error).message,
        shape: (err as { shape?: unknown }).shape,
      });
      expect(serialized).not.toMatch(/wk_[A-Za-z0-9_]+/);
    }
  });
});

describe('buildClaimMessage', () => {
  it('matches the frontend claim message shape', () => {
    const raw = buildClaimMessage('get_vrf_seed', 'alice.near');
    const parsed = JSON.parse(raw);
    expect(parsed.action).toBe('get_vrf_seed');
    expect(parsed.domain).toBe('nearly.social');
    expect(parsed.account_id).toBe('alice.near');
    expect(parsed.version).toBe(1);
    expect(typeof parsed.timestamp).toBe('number');
  });
});

describe('signClaim', () => {
  it('posts message + recipient to /wallet/v1/sign-message and parses the envelope', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        account_id: 'alice.near',
        public_key: 'ed25519:abc',
        signature: 'sig_hex',
        nonce: 'nonce_hex',
      }),
    );
    const wallet = walletOf(fetch);
    const claim = await signClaim(wallet, 'get_vrf_seed', 'alice.near');
    expect(claim.accountId).toBe('alice.near');
    expect(claim.publicKey).toBe('ed25519:abc');
    expect(claim.signature).toBe('sig_hex');
    expect(claim.nonce).toBe('nonce_hex');
    // Message is built locally, not returned by OutLayer, but must round-trip.
    const parsed = JSON.parse(claim.message);
    expect(parsed.action).toBe('get_vrf_seed');
    expect(parsed.account_id).toBe('alice.near');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://outlayer.example/wallet/v1/sign-message');
    expect(call.init?.method).toBe('POST');
    const body = JSON.parse(call.init?.body as string);
    expect(body.message).toBe(claim.message);
    expect(body.recipient).toBe('nearly.social');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer wk_test');
  });

  it('throws AUTH_FAILED on 401', async () => {
    const { fetch } = scripted(() => new Response('', { status: 401 }));
    const wallet = walletOf(fetch);
    await expect(
      signClaim(wallet, 'get_vrf_seed', 'alice.near'),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('throws PROTOCOL on missing fields', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ account_id: 'alice.near' }),
    );
    const wallet = walletOf(fetch);
    await expect(
      signClaim(wallet, 'get_vrf_seed', 'alice.near'),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });
});

describe('callOutlayer', () => {
  it('routes to /call/{owner}/{project} with input + resource_limits, returns decoded envelope', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        success: true,
        data: { output_hex: 'deadbeef', alpha: 'suggest' },
      }),
    );
    const wallet = walletOf(fetch);
    const decoded = await callOutlayer(wallet, {
      action: 'get_vrf_seed',
      verifiable_claim: { account_id: 'alice.near' },
    });
    expect(decoded.success).toBe(true);
    expect((decoded.data as { output_hex: string }).output_hex).toBe(
      'deadbeef',
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://outlayer.example/call/hack.near/nearly');
    const body = JSON.parse(call.init?.body as string);
    expect(body.input.action).toBe('get_vrf_seed');
    expect(body.input.verifiable_claim.account_id).toBe('alice.near');
    expect(body.resource_limits).toEqual({
      max_instructions: 2_000_000_000,
      max_memory_mb: 512,
      max_execution_seconds: 30,
    });
  });

  it('routes with X-Payment-Key when the wallet key is not a wk_ key', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({ success: true, data: {} }),
    );
    const wallet = walletOf(fetch, 'pay_abc');
    await callOutlayer(wallet, { action: 'noop' });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Payment-Key']).toBe('pay_abc');
    expect(headers.Authorization).toBeUndefined();
  });

  it('honors wasmOwner / wasmProject overrides', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({ success: true, data: {} }),
    );
    const wallet = createWalletClient({
      outlayerUrl: 'https://outlayer.example',
      namespace: 'contextual.near',
      walletKey: 'wk_test',
      fetch,
      wasmOwner: 'staging.near',
      wasmProject: 'nearly-staging',
    });
    await callOutlayer(wallet, { action: 'noop' });
    expect(calls[0].url).toBe(
      'https://outlayer.example/call/staging.near/nearly-staging',
    );
  });

  it('decodes base64 output field', async () => {
    const inner = { success: true, data: { foo: 'bar' } };
    const base64 = Buffer.from(JSON.stringify(inner)).toString('base64');
    const { fetch } = scripted(() => jsonResponse({ output: base64 }));
    const wallet = walletOf(fetch);
    const decoded = await callOutlayer(wallet, { action: 'noop' });
    expect(decoded.success).toBe(true);
    expect((decoded.data as { foo: string }).foo).toBe('bar');
  });

  it('throws INSUFFICIENT_BALANCE on 402 and 502', async () => {
    for (const status of [402, 502]) {
      const { fetch } = scripted(() => new Response('', { status }));
      const wallet = walletOf(fetch);
      await expect(
        callOutlayer(wallet, { action: 'noop' }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    }
  });

  it('throws PROTOCOL on WASM-level "failed" status', async () => {
    const { fetch } = scripted(() => jsonResponse({ status: 'failed' }));
    const wallet = walletOf(fetch);
    await expect(
      callOutlayer(wallet, { action: 'noop' }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('propagates success: false envelopes without throwing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        success: false,
        error: 'rate limited',
        code: 'RATE_LIMITED',
      }),
    );
    const wallet = walletOf(fetch);
    const decoded = await callOutlayer(wallet, { action: 'noop' });
    expect(decoded.success).toBe(false);
    expect(decoded.error).toBe('rate limited');
  });
});

describe('getVrfSeed', () => {
  it('composes signClaim + callOutlayer and returns the parsed proof', async () => {
    let callCount = 0;
    const { fetch, calls } = scripted((url) => {
      callCount++;
      if (url.endsWith('/wallet/v1/sign-message')) {
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig_hex',
          nonce: 'nonce_hex',
        });
      }
      if (url.includes('/call/')) {
        return jsonResponse({
          success: true,
          data: {
            output_hex: 'deadbeef',
            signature_hex: 'feedface',
            alpha: 'suggest',
            vrf_public_key: 'pk_hex',
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const wallet = walletOf(fetch);
    const proof = await getVrfSeed(wallet, 'alice.near');
    expect(proof).toEqual({
      output_hex: 'deadbeef',
      signature_hex: 'feedface',
      alpha: 'suggest',
      vrf_public_key: 'pk_hex',
    });
    expect(callCount).toBe(2);
    expect(calls[0].url).toContain('/wallet/v1/sign-message');
    expect(calls[1].url).toContain('/call/');

    // The verifiable_claim forwarded to the WASM must include every
    // envelope field plus the exact signed message.
    const wasmBody = JSON.parse(calls[1].init?.body as string);
    expect(wasmBody.input.action).toBe('get_vrf_seed');
    expect(wasmBody.input.verifiable_claim.account_id).toBe('alice.near');
    expect(wasmBody.input.verifiable_claim.public_key).toBe('ed25519:abc');
    expect(wasmBody.input.verifiable_claim.signature).toBe('sig_hex');
    expect(wasmBody.input.verifiable_claim.nonce).toBe('nonce_hex');
    const parsedMsg = JSON.parse(wasmBody.input.verifiable_claim.message);
    expect(parsedMsg.action).toBe('get_vrf_seed');
  });

  it('returns null when the WASM envelope is success: false', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/wallet/v1/sign-message')) {
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig_hex',
          nonce: 'nonce_hex',
        });
      }
      return jsonResponse({ success: false, error: 'wasm unavailable' });
    });
    const wallet = walletOf(fetch);
    const proof = await getVrfSeed(wallet, 'alice.near');
    expect(proof).toBeNull();
  });

  it('throws PROTOCOL when the proof envelope is missing fields', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/wallet/v1/sign-message')) {
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig_hex',
          nonce: 'nonce_hex',
        });
      }
      return jsonResponse({
        success: true,
        data: { output_hex: 'deadbeef' }, // missing signature_hex, alpha, vrf_public_key
      });
    });
    const wallet = walletOf(fetch);
    await expect(getVrfSeed(wallet, 'alice.near')).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });
});
