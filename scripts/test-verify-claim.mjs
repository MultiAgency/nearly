#!/usr/bin/env node
/**
 * End-to-end test script for the general-purpose NEP-413 verifier.
 *
 * Usage:
 *   node scripts/test-verify-claim.mjs
 *   node scripts/test-verify-claim.mjs --url https://nearly.social/api/v1/verify-claim
 *   NEARLY_VERIFY_URL=https://... node scripts/test-verify-claim.mjs
 *
 * Scenarios 1–8 sign fresh NEP-413 claims using local Node 22 WebCrypto and
 * post them to the verify-claim endpoint. They use implicit NEAR accounts
 * (account_id = hex(pubkey)) so the server never has to touch NEAR RPC —
 * these scenarios run offline-end-to-end against a local `next dev` or any
 * deployed instance.
 *
 * Scenario 9 optionally exercises the NAMED-account path: if
 * `OUTLAYER_TEST_WALLET_KEY` is set (shell env or `frontend/.env`), the script
 * signs via OutLayer's `/wallet/v1/sign-message` with a real `wk_`, posts
 * the resulting envelope to verify-claim, and asserts the server performs
 * the `view_access_key` lookup against NEAR RPC. Without this scenario,
 * 100% of verify-claim coverage runs through implicit accounts and the
 * named-account on-chain binding is untested. The scenario is skipped
 * (not failed) when the wallet key is not available.
 *
 * Exits 0 on all pass, 1 otherwise.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://localhost:3000/api/v1/verify-claim';
const DEFAULT_OUTLAYER_URL = 'https://api.outlayer.fastnear.com';
const FETCH_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const out = { url: process.env.NEARLY_VERIFY_URL ?? DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(
        'Usage: node scripts/test-verify-claim.mjs [--url <endpoint>]',
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base58 encoder (Bitcoin alphabet) — NEAR's wire format for keys/signatures.
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
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

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// NEP-413 payload construction + signing
// ---------------------------------------------------------------------------

/** NEP-413 Borsh tag = 2^31 + 413 = 0x8000019D (little-endian). */
const NEP413_TAG = new Uint8Array([0x9d, 0x01, 0x00, 0x80]);

function u32Le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s) {
  const utf8 = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + utf8.length);
  out.set(u32Le(utf8.length), 0);
  out.set(utf8, 4);
  return out;
}

function concat(parts) {
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

/**
 * Sign a fresh NEP-413 claim with a throwaway Ed25519 keypair, using
 * `account_id = hex(pubkey)` so the verifier's implicit-account fast path
 * binds the claim without touching NEAR RPC.
 */
async function signClaim({
  action = 'login',
  domain = 'nearly.social',
  recipient = 'nearly.social',
  timestamp = Date.now(),
  nonceBytes,
} = {}) {
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

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function post(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return { status: 0, body: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await resp.json();
  } catch {}
  return { status: resp.status, body: json };
}

/**
 * Load OUTLAYER_TEST_WALLET_KEY from shell env first, then from
 * `frontend/.env` as a fallback. Returns null when neither is
 * available — the caller treats null as "skip this scenario,"
 * never as failure.
 */
function loadWalletKey() {
  if (process.env.OUTLAYER_TEST_WALLET_KEY) return process.env.OUTLAYER_TEST_WALLET_KEY;
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const envPath = join(scriptDir, '..', 'frontend', '.env');
    if (!existsSync(envPath)) return null;
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^OUTLAYER_TEST_WALLET_KEY=(.+)$/);
      if (match) return match[1].trim();
    }
  } catch {}
  return null;
}

/**
 * OutLayer HTTP helper with `Authorization: Bearer wk_...` header.
 * Returns `{status, body, error?}` mirroring the `post` helper above.
 * Used exclusively by scenario 9 (the OutLayer-signed path).
 */
async function outlayerCall(url, walletKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${walletKey}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return { status: 0, body: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await resp.json();
  } catch {}
  return { status: resp.status, body: json };
}

let passed = 0;
let failed = 0;
const USE_COLOR = process.stdout.isTTY;
const GREEN = USE_COLOR ? '\x1b[32m' : '';
const RED = USE_COLOR ? '\x1b[31m' : '';
const DIM = USE_COLOR ? '\x1b[2m' : '';
const RESET = USE_COLOR ? '\x1b[0m' : '';

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  ${GREEN}✓${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${name}`);
    if (detail) console.log(`      ${DIM}${detail}${RESET}`);
    failed++;
  }
}

async function run(url) {
  console.log(`Testing verify-claim at ${url}\n`);

  // 1. Happy path — implicit account, valid claim, expected_domain matches.
  {
    console.log('1. Happy path (implicit account, recipient+domain pinned)');
    const claim = await signClaim();
    const result = await post(url, {
      ...claim,
      recipient: 'nearly.social',
      expected_domain: 'nearly.social',
    });
    if (result.error) {
      console.error(
        `\n${RED}Could not reach ${url}: ${result.error}${RESET}\n` +
          'Start the dev server (cd frontend && npm run dev) or pass --url.',
      );
      process.exit(2);
    }
    const { status, body } = result;
    assert('status 200', status === 200, `got ${status}`);
    assert('valid: true', body?.valid === true, JSON.stringify(body));
    assert('recipient echoed', body?.recipient === 'nearly.social');
    assert("message.action === 'login'", body?.message?.action === 'login');
    assert('verified_at present', typeof body?.verified_at === 'number');
  }

  // 2. Wrong recipient — caller pins a different recipient than the signer used.
  {
    console.log('\n2. Wrong recipient (signed for A, verifier pins B)');
    const claim = await signClaim({
      recipient: 'market.near.ai',
      domain: 'market.near.ai',
    });
    const { status, body } = await post(url, {
      ...claim,
      recipient: 'nearly.social',
    });
    assert('status 200', status === 200);
    assert('valid: false', body?.valid === false);
    assert("reason: 'signature'", body?.reason === 'signature');
  }

  // 3. Missing recipient — route handler rejects with 400.
  {
    console.log('\n3. Missing recipient field');
    const claim = await signClaim();
    const { status, body } = await post(url, { ...claim });
    assert('status 400', status === 400, `got ${status}`);
    assert('success: false', body?.success === false);
  }

  // 4. Replay — submit the same claim twice, second must be rejected.
  {
    console.log('\n4. Replay detection');
    const claim = await signClaim();
    const first = await post(url, { ...claim, recipient: 'nearly.social' });
    assert('first valid: true', first.body?.valid === true);
    const second = await post(url, { ...claim, recipient: 'nearly.social' });
    assert('second valid: false', second.body?.valid === false);
    assert("second reason: 'replay'", second.body?.reason === 'replay');
  }

  // 5. Expected-domain mismatch — message.domain does not match the pin.
  {
    console.log('\n5. Expected-domain mismatch');
    const claim = await signClaim({ domain: 'nearly.social' });
    const { body } = await post(url, {
      ...claim,
      recipient: 'nearly.social',
      expected_domain: 'something.else',
    });
    assert('valid: false', body?.valid === false);
    assert("reason: 'malformed'", body?.reason === 'malformed');
  }

  // 6. Expected domain unset — domain pinning is opt-in.
  {
    console.log('\n6. Domain pin skipped when expected_domain is unset');
    const claim = await signClaim({
      recipient: 'market.near.ai',
      domain: 'whatever.xyz',
    });
    const { body } = await post(url, {
      ...claim,
      recipient: 'market.near.ai',
    });
    assert('valid: true', body?.valid === true, JSON.stringify(body));
  }

  // 7. Stale timestamp — older than the freshness window.
  {
    console.log('\n7. Stale timestamp');
    const claim = await signClaim({ timestamp: Date.now() - 10 * 60_000 });
    const { body } = await post(url, {
      ...claim,
      recipient: 'nearly.social',
    });
    assert('valid: false', body?.valid === false);
    assert("reason: 'expired'", body?.reason === 'expired');
  }

  // 8. Nonce canonicalization — strip base64 padding and retry; must replay.
  {
    console.log('\n8. Nonce canonicalization (padding-strip replay attempt)');
    const claim = await signClaim();
    const first = await post(url, { ...claim, recipient: 'nearly.social' });
    assert('first valid: true', first.body?.valid === true);
    const unpadded = claim.nonce.replace(/=+$/, '');
    const replay = await post(url, {
      ...claim,
      nonce: unpadded,
      recipient: 'nearly.social',
    });
    assert('replay valid: false', replay.body?.valid === false);
    assert("replay reason: 'replay'", replay.body?.reason === 'replay');
  }

  // 9. Real named-account case (OutLayer-signed via OUTLAYER_TEST_WALLET_KEY).
  //
  // Scenarios 1–8 sign with ephemeral local ed25519 keypairs and implicit
  // (64-hex) account IDs, so the server-side verifier derives the expected
  // public key directly from the account_id without touching NEAR RPC.
  // This scenario exercises the NAMED-account path: a real `wk_` signs
  // via OutLayer's `/wallet/v1/sign-message`, the envelope is POSTed to
  // `/verify-claim`, and the verifier performs a `view_access_key`
  // lookup against NEAR RPC to confirm the signing key is on the
  // account's chain state. Without this scenario, 100% of verify-claim
  // coverage runs through implicit accounts and the named-account
  // on-chain binding is untested end-to-end.
  //
  // Gated on OUTLAYER_TEST_WALLET_KEY (shell env or frontend/.env). Skipped,
  // not failed, when the wallet key is not available — the first eight
  // scenarios still run and still gate the implicit-account path.
  {
    console.log('\n9. Real named-account (OutLayer-signed)');
    const walletKey = loadWalletKey();
    if (!walletKey) {
      console.log(`  ${DIM}○ skipped (OUTLAYER_TEST_WALLET_KEY not set)${RESET}`);
    } else {
      const outlayerBase = process.env.OUTLAYER_API_URL ?? DEFAULT_OUTLAYER_URL;

      // Resolve account_id from the wallet key. /wallet/v1/balance
      // returns account_id alongside balance — no sign-message round-trip
      // needed to discover the wallet owner.
      const balanceRes = await outlayerCall(
        `${outlayerBase}/wallet/v1/balance?chain=near`,
        walletKey,
      );
      if (balanceRes.status !== 200) {
        assert(
          'resolve account_id via /wallet/v1/balance',
          false,
          `HTTP ${balanceRes.status}: ${JSON.stringify(balanceRes.body)}`,
        );
      } else {
        const accountId = balanceRes.body?.account_id;
        if (typeof accountId !== 'string' || !accountId) {
          assert(
            'balance response includes account_id',
            false,
            JSON.stringify(balanceRes.body),
          );
        } else {
          // Build a canonical NEP-413 inner-message matching the SDK's
          // `buildClaim` shape. The inner `account_id` must match the
          // outer signer or the server-side verifier rejects on the
          // account-binding guard.
          const message = JSON.stringify({
            action: 'verify_claim_smoke',
            domain: 'nearly.social',
            account_id: accountId,
            version: 1,
            timestamp: Date.now(),
          });

          // Ask OutLayer to sign. The response returns {account_id,
          // public_key, signature, nonce} as snake_case fields; OutLayer
          // does not echo back the message, so we supply it to complete
          // the envelope.
          const signRes = await outlayerCall(
            `${outlayerBase}/wallet/v1/sign-message`,
            walletKey,
            { message, recipient: 'nearly.social' },
          );
          if (signRes.status !== 200) {
            assert(
              '/wallet/v1/sign-message returned 200',
              false,
              `HTTP ${signRes.status}: ${JSON.stringify(signRes.body)}`,
            );
          } else if (
            typeof signRes.body?.signature !== 'string' ||
            typeof signRes.body?.public_key !== 'string'
          ) {
            assert(
              'sign-message response has signature + public_key',
              false,
              JSON.stringify(signRes.body),
            );
          } else {
            const envelope = {
              account_id: signRes.body.account_id,
              public_key: signRes.body.public_key,
              signature: signRes.body.signature,
              nonce: signRes.body.nonce,
              message,
            };

            // Positive: the verifier should call NEAR RPC `view_access_key`
            // for the named account and confirm the signing public key is
            // on-chain.
            const first = await post(url, {
              ...envelope,
              recipient: 'nearly.social',
            });
            assert(
              'first status 200',
              first.status === 200,
              `got ${first.status}: ${JSON.stringify(first.body)}`,
            );
            assert(
              'first valid: true',
              first.body?.valid === true,
              JSON.stringify(first.body),
            );
            assert(
              'first account_id matches resolved',
              first.body?.account_id === accountId,
              `expected ${accountId}, got ${first.body?.account_id}`,
            );

            // Replay negative: same envelope twice must be rejected.
            // Guards the replay store against named-account regressions.
            const second = await post(url, {
              ...envelope,
              recipient: 'nearly.social',
            });
            assert(
              'second valid: false',
              second.body?.valid === false,
              JSON.stringify(second.body),
            );
            assert(
              "second reason: 'replay'",
              second.body?.reason === 'replay',
              JSON.stringify(second.body),
            );
          }
        }
      }
    }
  }

  console.log(
    `\n${passed + failed} checks — ${GREEN}${passed} passed${RESET}, ${failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed'}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

const { url } = parseArgs(process.argv.slice(2));
run(url).catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
