/**
 * @jest-environment node
 */

import {
  buildClaimMessage,
  type Nep413Signer,
  signClaim,
} from '@/lib/sign-claim';

/**
 * `signClaim` is the client-side NEP-413 claim producer for the
 * Lightweight sign-in feature. These tests exercise its composition
 * logic against a mock `Nep413Signer` — no NEAR Connect, no NearProvider,
 * no React. The integration round-trip (real wallet → real verify-claim
 * endpoint) is a manual test covered by the throwaway button on the
 * sign-in page; this suite only covers the pure-ish composition layer.
 */

function makeSigner(overrides?: {
  accountId?: string;
  publicKey?: string;
  signature?: string;
  captureCall?: (params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
  }) => void;
}): Nep413Signer {
  return async (params) => {
    overrides?.captureCall?.(params);
    return {
      accountId: overrides?.accountId ?? 'alice.near',
      publicKey: overrides?.publicKey ?? 'ed25519:testpubkey',
      signature: overrides?.signature ?? 'ed25519:testsignature',
    };
  };
}

describe('buildClaimMessage', () => {
  it('emits the canonical inner-message shape the server verifier expects', () => {
    // Matches `outlayer-server.ts::buildClaimMessage` exactly so claims
    // signed on the browser side and claims signed by OutLayer's server
    // produce identical envelopes — the verifier cannot distinguish them,
    // which is the whole point of the shared path.
    const message = buildClaimMessage(
      'operator_claim',
      'alice.near',
      1_700_000_000_000,
    );
    expect(JSON.parse(message)).toEqual({
      action: 'operator_claim',
      domain: 'nearly.social',
      account_id: 'alice.near',
      version: 1,
      timestamp: 1_700_000_000_000,
    });
  });
});

describe('signClaim', () => {
  it('returns a VerifiableClaim composed from the signer output plus inputs', async () => {
    const signer = makeSigner({
      accountId: 'alice.near',
      publicKey: 'ed25519:abc',
      signature: 'ed25519:def',
    });
    const fixedNonce = new Uint8Array(32).fill(0x42);
    const claim = await signClaim(
      {
        signNEP413Message: signer,
        accountId: 'alice.near',
        now: () => 1_700_000_000_000,
        generateNonce: () => fixedNonce,
      },
      'operator_claim',
      'nearly.social',
    );

    // `account_id`, `public_key`, and `signature` come from the wallet's
    // NEP-413 return — not from the input `accountId`. If a hostile caller
    // passed a mismatched `accountId`, the signer's authoritative return
    // still wins on the outer fields (and the inner message's account_id
    // becomes the forgery vector that the server-side guard rejects).
    expect(claim.account_id).toBe('alice.near');
    expect(claim.public_key).toBe('ed25519:abc');
    expect(claim.signature).toBe('ed25519:def');
    // 32 bytes of 0x42 → base64 of "BBBB" repeating 10x + "BB" = "QkJC..." pattern.
    // Tolerant assertion: the nonce decodes back to 32 bytes.
    expect(Buffer.from(claim.nonce, 'base64')).toEqual(Buffer.from(fixedNonce));
    // Inner message must carry the asserted account_id and the injected
    // timestamp — the server's `verifyClaim` cross-checks both.
    const parsed = JSON.parse(claim.message);
    expect(parsed.account_id).toBe('alice.near');
    expect(parsed.timestamp).toBe(1_700_000_000_000);
    expect(parsed.domain).toBe('nearly.social');
    expect(parsed.action).toBe('operator_claim');
  });

  it('passes message, recipient, and nonce through to the signer verbatim', async () => {
    const captured: {
      message?: string;
      recipient?: string;
      nonce?: Uint8Array;
    } = {};
    const signer = makeSigner({
      captureCall: (params) => {
        captured.message = params.message;
        captured.recipient = params.recipient;
        captured.nonce = params.nonce;
      },
    });
    const fixedNonce = new Uint8Array([1, 2, 3, 4]);

    await signClaim(
      {
        signNEP413Message: signer,
        accountId: 'bob.near',
        now: () => 1_700_000_000_000,
        generateNonce: () => fixedNonce,
      },
      'login',
      'nearly.social',
    );

    expect(captured.recipient).toBe('nearly.social');
    expect(captured.nonce).toBe(fixedNonce);
    // The exact message the wallet signs over — tests guard against a
    // regression where the inner message is composed with a different
    // shape than `outlayer-server.ts::buildClaimMessage`, which would
    // silently break cross-consumer verification.
    expect(JSON.parse(captured.message ?? '')).toEqual({
      action: 'login',
      domain: 'nearly.social',
      account_id: 'bob.near',
      version: 1,
      timestamp: 1_700_000_000_000,
    });
  });

  it('generates a fresh 32-byte nonce via the injection point by default', async () => {
    // Don't override `generateNonce` — exercise the default path.
    // jsdom/node both provide `crypto.getRandomValues`, so the default
    // factory works under jest without a polyfill.
    const signer = makeSigner();
    const claim = await signClaim(
      {
        signNEP413Message: signer,
        accountId: 'alice.near',
        now: () => 1_700_000_000_000,
      },
      'login',
      'nearly.social',
    );
    expect(Buffer.from(claim.nonce, 'base64').length).toBe(32);
  });

  it('uses Date.now by default when `now` is not injected', async () => {
    const signer = makeSigner();
    const beforeSign = Date.now();
    const claim = await signClaim(
      {
        signNEP413Message: signer,
        accountId: 'alice.near',
        // Override nonce to keep the test quick; leave `now` on default.
        generateNonce: () => new Uint8Array(32),
      },
      'login',
      'nearly.social',
    );
    const afterSign = Date.now();
    const parsed = JSON.parse(claim.message);
    expect(parsed.timestamp).toBeGreaterThanOrEqual(beforeSign);
    expect(parsed.timestamp).toBeLessThanOrEqual(afterSign);
  });

  it('propagates signer rejections without catching', async () => {
    const failingSigner: Nep413Signer = async () => {
      throw new Error('user rejected sign-in');
    };
    await expect(
      signClaim(
        {
          signNEP413Message: failingSigner,
          accountId: 'alice.near',
        },
        'login',
        'nearly.social',
      ),
    ).rejects.toThrow('user rejected sign-in');
  });
});
