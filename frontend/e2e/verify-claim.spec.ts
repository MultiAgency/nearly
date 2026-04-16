import { expect, test } from '@playwright/test';

/*
 * NEP-413 verify-claim E2E — scenarios 1–8 from scripts/test-verify-claim.mjs.
 *
 * Uses Node 22 WebCrypto to sign ephemeral implicit-account claims.
 * No wallet keys, no NEAR RPC — runs in CI without secrets.
 * Scenario 9 (named-account, OutLayer-signed) stays in the script.
 */

// ── Primitives ───────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < zeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** NEP-413 Borsh tag = 2^31 + 413 = 0x8000019D (little-endian). */
const NEP413_TAG = new Uint8Array([0x9d, 0x01, 0x00, 0x80]);

function u32Le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + utf8.length);
  out.set(u32Le(utf8.length), 0);
  out.set(utf8, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function signClaim(
  opts: {
    action?: string;
    domain?: string;
    recipient?: string;
    timestamp?: number;
    nonceBytes?: Uint8Array;
  } = {},
) {
  const {
    action = 'login',
    domain = 'nearly.social',
    recipient = 'nearly.social',
    timestamp = Date.now(),
    nonceBytes,
  } = opts;

  const kp = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const pubkeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', kp.publicKey),
  );
  const accountId = toHex(pubkeyBytes);

  const message = JSON.stringify({
    action,
    domain,
    account_id: accountId,
    version: 1,
    timestamp,
  });

  const nonce = nonceBytes ?? crypto.getRandomValues(new Uint8Array(32));
  const payload = concat([
    NEP413_TAG,
    borshString(message),
    nonce,
    borshString(recipient),
    new Uint8Array([0x00]),
  ]);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', kp.privateKey, hash),
  );

  return {
    account_id: accountId,
    public_key: `ed25519:${base58Encode(pubkeyBytes)}`,
    signature: base58Encode(sig),
    nonce: Buffer.from(nonce).toString('base64'),
    message,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────

const VERIFY = 'verify-claim';

test('1. happy path — implicit account, recipient+domain pinned', async ({
  request,
}) => {
  const claim = await signClaim();
  const res = await request.post(VERIFY, {
    data: {
      ...claim,
      recipient: 'nearly.social',
      expected_domain: 'nearly.social',
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.valid).toBe(true);
  expect(body.recipient).toBe('nearly.social');
  expect(body.message.action).toBe('login');
  expect(typeof body.verified_at).toBe('number');
});

test('2. wrong recipient — signed for A, verifier pins B', async ({
  request,
}) => {
  const claim = await signClaim({
    recipient: 'market.near.ai',
    domain: 'market.near.ai',
  });
  const res = await request.post(VERIFY, {
    data: { ...claim, recipient: 'nearly.social' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.valid).toBe(false);
  expect(body.reason).toBe('signature');
});

test('3. missing recipient — 400', async ({ request }) => {
  const claim = await signClaim();
  const res = await request.post(VERIFY, { data: { ...claim } });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.success).toBe(false);
});

test('4. replay detection', async ({ request }) => {
  const claim = await signClaim();
  const payload = { ...claim, recipient: 'nearly.social' };
  const first = await request.post(VERIFY, { data: payload });
  expect((await first.json()).valid).toBe(true);

  const second = await request.post(VERIFY, { data: payload });
  const body = await second.json();
  expect(body.valid).toBe(false);
  expect(body.reason).toBe('replay');
});

test('5. expected-domain mismatch', async ({ request }) => {
  const claim = await signClaim({ domain: 'nearly.social' });
  const res = await request.post(VERIFY, {
    data: {
      ...claim,
      recipient: 'nearly.social',
      expected_domain: 'something.else',
    },
  });
  const body = await res.json();
  expect(body.valid).toBe(false);
  expect(body.reason).toBe('malformed');
});

test('6. domain pin skipped when expected_domain unset', async ({
  request,
}) => {
  const claim = await signClaim({
    recipient: 'market.near.ai',
    domain: 'whatever.xyz',
  });
  const res = await request.post(VERIFY, {
    data: { ...claim, recipient: 'market.near.ai' },
  });
  const body = await res.json();
  expect(body.valid).toBe(true);
});

test('7. stale timestamp', async ({ request }) => {
  const claim = await signClaim({ timestamp: Date.now() - 10 * 60_000 });
  const res = await request.post(VERIFY, {
    data: { ...claim, recipient: 'nearly.social' },
  });
  const body = await res.json();
  expect(body.valid).toBe(false);
  expect(body.reason).toBe('expired');
});

test('8. nonce canonicalization — padding-strip replay', async ({
  request,
}) => {
  const claim = await signClaim();
  const first = await request.post(VERIFY, {
    data: { ...claim, recipient: 'nearly.social' },
  });
  expect((await first.json()).valid).toBe(true);

  const unpadded = claim.nonce.replace(/=+$/, '');
  const second = await request.post(VERIFY, {
    data: { ...claim, nonce: unpadded, recipient: 'nearly.social' },
  });
  const body = await second.json();
  expect(body.valid).toBe(false);
  expect(body.reason).toBe('replay');
});
