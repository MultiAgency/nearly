import type { FetchLike } from '../src/read';
import { getVrfSeed } from '../src/vrf';
import { jsonResponse, walletOf } from './fixtures/http';

/**
 * Scripted fetch that serves different responses for sign-message vs call.
 * getVrfSeed makes two requests: signClaim → signMessage, then callOutlayer.
 */
function vrfFetch(opts: {
  signResponse?: unknown;
  callResponse?: unknown;
  callStatus?: number;
}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let callIndex = 0;
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    // First call is sign-message, second is call (WASM)
    if (callIndex++ === 0) {
      return jsonResponse(
        opts.signResponse ?? {
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig',
          nonce: 'bm9uY2U=',
          message: '{"action":"get_vrf_seed"}',
        },
      );
    }
    return jsonResponse(
      opts.callResponse ?? {
        success: true,
        data: {
          output_hex: 'aabb',
          signature_hex: 'ccdd',
          alpha: 'ee',
          vrf_public_key: 'ff',
        },
      },
      opts.callStatus ?? 200,
    );
  };
  return { fetch, calls };
}

describe('getVrfSeed', () => {
  it('returns VrfProof on success', async () => {
    const { fetch } = vrfFetch({});
    const result = await getVrfSeed(walletOf(fetch), 'alice.near');
    expect(result).toEqual({
      output_hex: 'aabb',
      signature_hex: 'ccdd',
      alpha: 'ee',
      vrf_public_key: 'ff',
    });
  });

  it('returns null when WASM responds with success: false', async () => {
    const { fetch } = vrfFetch({
      callResponse: { success: false, error: 'VRF_ERROR' },
    });
    const result = await getVrfSeed(walletOf(fetch), 'alice.near');
    expect(result).toBeNull();
  });

  it.each([
    ['partial data', { success: true, data: { output_hex: 'aabb' } }],
    ['missing data', { success: true }],
  ])('throws PROTOCOL on malformed response (%s)', async (_label, callResponse) => {
    const { fetch } = vrfFetch({ callResponse });
    await expect(
      getVrfSeed(walletOf(fetch), 'alice.near'),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('calls sign-message then call endpoints', async () => {
    const { fetch, calls } = vrfFetch({});
    await getVrfSeed(walletOf(fetch), 'alice.near');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/sign-message');
    expect(calls[1]).toContain('/call/');
  });
});
