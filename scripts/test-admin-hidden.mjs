#!/usr/bin/env node
/**
 * End-to-end smoke for the admin hide/unhide lifecycle.
 *
 *   GET    /api/v1/admin/hidden         — public list
 *   POST   /api/v1/admin/hidden/{id}    — hide (admin auth)
 *   DELETE /api/v1/admin/hidden/{id}    — unhide (admin auth)
 *
 * The handler lives in `frontend/src/app/api/v1/[...path]/route.ts` and
 * is gated via `assertAdminAuth` — the caller's account_id (from a near:
 * token or wk_) must match `OUTLAYER_ADMIN_ACCOUNT`.
 *
 * This script authenticates with a `Bearer near:<base64url>` token built
 * from hack.near's NEAR ed25519 key. The token format matches the
 * server's `buildAdminNearToken` in `outlayer-server.ts`: sign
 * `"auth:<seed>:<timestamp>"`, bundle `{account_id, seed, pubkey,
 * timestamp, signature}` into base64url JSON.
 *
 * Usage:
 *   node scripts/test-admin-hidden.mjs
 *   node scripts/test-admin-hidden.mjs --api http://localhost:3000/api/v1
 *   node scripts/test-admin-hidden.mjs --target some-account.near
 *   node scripts/test-admin-hidden.mjs --dry-run
 *
 * Credentials:
 *   OUTLAYER_ADMIN_NEAR_KEY  — ed25519 private key (shell env or frontend/.env).
 *                              Falls back to ~/.near-credentials/mainnet/<account>.json.
 *   OUTLAYER_ADMIN_ACCOUNT   — the admin account_id (e.g. hack.near)
 *
 * Target:
 *   --target <account>  — the account to hide and then unhide. Defaults
 *                         to `smoke-target.near` (a clearly-labeled
 *                         placeholder name). Hiding a non-existent
 *                         account is a no-op on the frontend — the
 *                         admin hidden set just stores a string under
 *                         the admin's predecessor. Pass a real directory
 *                         account (e.g. `--target 4397d730...`) if you
 *                         want a visible hide/unhide on the agents page.
 *
 * Exit codes:
 *   0 — all phases passed
 *   1 — at least one phase failed
 *   2 — configuration error (missing env vars, NEAR key not found, etc.)
 *
 * Side effects:
 *   The script hides and then unhides the target account. If it
 *   crashes between the hide and the unhide, the target stays hidden
 *   until the next run's retry-unhide step catches it or a human
 *   cleans up. A `finally`-block unhide runs on any post-hide exit
 *   path. Passing `--dry-run` skips both writes and only exercises
 *   the read paths + config/precondition checks.
 */

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://nearly.social/api/v1';
const FETCH_TIMEOUT_MS = 15_000;
const INDEXER_POLL_ATTEMPTS = 20;
const INDEXER_POLL_INTERVAL_MS = 1_500;
const ADMIN_SEED = 'admin';
const DER_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// ---------------------------------------------------------------------------
// Base58
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

function b58decode(s) {
  let bytes = [0];
  for (const ch of s) {
    let carry = B58_MAP[ch];
    if (carry === undefined) throw new Error('bad base58 char: ' + ch);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch !== '1') break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}

function b58encode(buf) {
  const bytes = [...buf];
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
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

// ---------------------------------------------------------------------------
// near: token builder
// ---------------------------------------------------------------------------

function buildNearToken(accountId, nearKeyB58) {
  const raw = b58decode(nearKeyB58.replace(/^ed25519:/, ''));
  if (raw.length !== 64) {
    configError(`NEAR key must be 64 bytes after base58 decode, got ${raw.length}`);
  }
  const seed32 = raw.slice(0, 32);
  const pub32 = raw.slice(32);
  const privKey = createPrivateKey({
    key: Buffer.concat([DER_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubkeyB58 = `ed25519:${b58encode(pub32)}`;
  const ts = Math.floor(Date.now() / 1000);
  const message = `auth:${ADMIN_SEED}:${ts}`;
  const sigBytes = cryptoSign(null, Buffer.from(message), privKey);
  const signatureB58 = b58encode(new Uint8Array(sigBytes));
  const payload = JSON.stringify({
    account_id: accountId,
    seed: ADMIN_SEED,
    pubkey: pubkeyB58,
    timestamp: ts,
    signature: signatureB58,
  });
  return `near:${Buffer.from(payload).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Argument + env loading
// ---------------------------------------------------------------------------

const DEFAULT_TARGET = 'smoke-target.near';

function parseArgs(argv) {
  const out = {
    api: process.env.NEARLY_API ?? DEFAULT_API,
    target: DEFAULT_TARGET,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api' && argv[i + 1]) out.api = argv[++i];
    else if (argv[i] === '--target' && argv[i + 1]) out.target = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(
        'Usage: node scripts/test-admin-hidden.mjs [--api <base>] [--target <account>] [--dry-run]\n' +
          '\n' +
          `  --target   account to hide/unhide (default: ${DEFAULT_TARGET})\n` +
          '  --dry-run  reads + preconditions only, no writes\n' +
          '  --api      API base URL (default: production)\n' +
          '\n' +
          'Env:\n' +
          '  OUTLAYER_ADMIN_NEAR_KEY   admin NEAR ed25519 key (or ~/.near-credentials/)\n' +
          '  OUTLAYER_ADMIN_ACCOUNT    admin account_id (e.g. hack.near)\n' +
          '  NEARLY_API                API base URL (env form of --api)\n',
      );
      process.exit(0);
    }
  }
  return out;
}

function loadEnvVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const envPath = join(scriptDir, '..', 'frontend', '.env');
    if (!existsSync(envPath)) return null;
    const content = readFileSync(envPath, 'utf8');
    const pattern = new RegExp(`^${name}=(.+)$`);
    for (const line of content.split('\n')) {
      const match = line.match(pattern);
      if (match) return match[1].trim();
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const USE_COLOR = process.stdout.isTTY;
const GREEN = USE_COLOR ? '\x1b[32m' : '';
const RED = USE_COLOR ? '\x1b[31m' : '';
const YELLOW = USE_COLOR ? '\x1b[33m' : '';
const DIM = USE_COLOR ? '\x1b[2m' : '';
const RESET = USE_COLOR ? '\x1b[0m' : '';

let passed = 0;
let failed = 0;

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

function phase(title) {
  console.log(`\n${title}`);
}

function configError(msg) {
  console.error(`\n${RED}Configuration error:${RESET} ${msg}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function request(method, url, { walletKey, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        ...(walletKey && { Authorization: `Bearer ${walletKey}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
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
 * Load the NEAR ed25519 private key for admin auth.
 * Priority: OUTLAYER_ADMIN_NEAR_KEY env/frontend/.env, then
 * ~/.near-credentials/mainnet/<accountId>.json.
 */
function loadNearKey(accountId) {
  const fromEnv = loadEnvVar('OUTLAYER_ADMIN_NEAR_KEY');
  if (fromEnv) return fromEnv;
  try {
    const credPath = join(
      homedir(),
      '.near-credentials',
      'mainnet',
      `${accountId}.json`,
    );
    if (!existsSync(credPath)) return null;
    const creds = JSON.parse(readFileSync(credPath, 'utf8'));
    return creds.private_key ?? null;
  } catch {
    return null;
  }
}

/**
 * Poll GET /admin/hidden until the assertion returns true, with a
 * fixed retry budget. Passes a near: token to bypass the server's
 * in-memory cache (same pattern as wallet-auth bypass on other
 * endpoints).
 */
async function pollHidden(api, walletKey, assertion) {
  let lastBody = null;
  for (let attempt = 1; attempt <= INDEXER_POLL_ATTEMPTS; attempt++) {
    const res = await request('GET', `${api}/admin/hidden`, { walletKey });
    if (res.status !== 200) {
      return { ok: false, status: res.status, body: res.body };
    }
    lastBody = res.body;
    if (assertion(res.body)) return { ok: true, status: 200, body: res.body };
    if (attempt < INDEXER_POLL_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, INDEXER_POLL_INTERVAL_MS));
    }
  }
  return { ok: false, status: 200, body: lastBody };
}

async function safeUnhide(api, target, walletKey) {
  try {
    await request(
      'DELETE',
      `${api}/admin/hidden/${encodeURIComponent(target)}`,
      { walletKey },
    );
  } catch {
    // Swallow — this is a cleanup path run from `finally`. The user
    // will see the visible hide state in the directory if it fails.
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { api, target, dryRun } = parseArgs(process.argv.slice(2));
  const adminAccount = loadEnvVar('OUTLAYER_ADMIN_ACCOUNT');

  if (!adminAccount) {
    configError('OUTLAYER_ADMIN_ACCOUNT is not set (shell env or frontend/.env).');
  }

  const nearKey = loadNearKey(adminAccount);
  if (!nearKey) {
    configError(
      `No NEAR key found for ${adminAccount}. Set OUTLAYER_ADMIN_NEAR_KEY in ` +
        `frontend/.env or ensure ~/.near-credentials/mainnet/${adminAccount}.json exists.`,
    );
  }

  // Build a fresh near: token for each request phase. The token has a
  // ±30s timestamp window, so one token per main() call is fine — but
  // we rebuild per-phase to keep the poll window's tokens fresh.
  function freshToken() {
    return buildNearToken(adminAccount, nearKey);
  }

  console.log(`Testing admin hide/unhide at ${api}`);
  if (dryRun) {
    console.log(`  ${YELLOW}(dry-run: reads + preconditions only, no writes)${RESET}`);
  }
  console.log(`  admin:   ${adminAccount}`);
  console.log(`  auth:    near: token (ed25519)`);
  console.log(`  target:  ${target}`);

  // Precondition: target must not be the admin itself.
  if (target === adminAccount) {
    configError(
      `--target equals OUTLAYER_ADMIN_ACCOUNT — cannot hide the admin's own account.`,
    );
  }

  console.log();

  // Phase 0 — preflight the public list endpoint and capture baseline.
  phase('Phase 0. Preflight — GET /admin/hidden');
  let baselineHidden = [];
  {
    const res = await request('GET', `${api}/admin/hidden`);
    assert(
      'list endpoint reachable (HTTP 200)',
      res.status === 200,
      `got HTTP ${res.status}`,
    );
    assert(
      'response has data.hidden array',
      Array.isArray(res.body?.data?.hidden),
      JSON.stringify(res.body),
    );
    if (Array.isArray(res.body?.data?.hidden)) {
      baselineHidden = res.body.data.hidden;
      console.log(
        `      ${DIM}${baselineHidden.length} account${baselineHidden.length === 1 ? '' : 's'} currently hidden${RESET}`,
      );
    }
  }

  // If the target is already in the hidden set, we can still exercise
  // the lifecycle — hide is idempotent, unhide returns to the same
  // state. Note it in the log so the operator is aware.
  const targetAlreadyHidden = baselineHidden.includes(target);
  if (targetAlreadyHidden) {
    console.log(
      `      ${YELLOW}note: target ${target} is already in the hidden set${RESET}`,
    );
  }

  if (dryRun) {
    console.log(
      `\n${YELLOW}dry-run: skipping phases 1–4 (write paths)${RESET}`,
    );
    console.log(
      `\n${passed + failed} checks — ${GREEN}${passed} passed${RESET}, ${
        failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed'
      }`,
    );
    process.exit(failed > 0 ? 1 : 0);
  }

  // A latch for the finally-cleanup: only run the safety unhide if
  // the hide actually succeeded AND the target was not already hidden
  // at baseline (we don't want to "restore" a state the caller put
  // themselves in before running the script).
  let hideLatched = false;

  try {
    // Phase 1 — POST /admin/hidden/{target}
    phase('Phase 1. POST /admin/hidden/' + target);
    {
      const res = await request(
        'POST',
        `${api}/admin/hidden/${encodeURIComponent(target)}`,
        { walletKey: freshToken() },
      );
      assert(
        'POST HTTP 200',
        res.status === 200,
        `got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert(
        "action === 'hidden'",
        res.body?.data?.action === 'hidden',
        JSON.stringify(res.body),
      );
      assert(
        'account_id echoes target',
        res.body?.data?.account_id === target,
      );
      if (res.status === 200 && !targetAlreadyHidden) {
        hideLatched = true;
      }
    }

    // Phase 2 — GET /admin/hidden and verify the target appears.
    phase('Phase 2. Verify target is in the hidden set');
    {
      const poll = await pollHidden(api, freshToken(), (body) =>
        Array.isArray(body?.data?.hidden)
          ? body.data.hidden.includes(target)
          : false,
      );
      assert(
        'target present in hidden set',
        poll.ok,
        poll.ok ? null : `last body: ${JSON.stringify(poll.body).slice(0, 400)}`,
      );
    }

    // Phase 3 — DELETE /admin/hidden/{target}. Explicit unhide,
    // mirrors the POST above. The finally-block also has an unhide
    // but will no-op if this one succeeds first.
    phase('Phase 3. DELETE /admin/hidden/' + target);
    {
      const res = await request(
        'DELETE',
        `${api}/admin/hidden/${encodeURIComponent(target)}`,
        { walletKey: freshToken() },
      );
      assert(
        'DELETE HTTP 200',
        res.status === 200,
        `got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert(
        "action === 'unhidden'",
        res.body?.data?.action === 'unhidden',
        JSON.stringify(res.body),
      );
      if (res.status === 200) {
        hideLatched = false;
      }
    }

    // Phase 4 — GET /admin/hidden and verify the target is gone.
    // If the target was in the baseline set, "gone" means "gone from
    // what we added" — we don't assert an empty list, only that the
    // target's entry (as of this run) is absent.
    phase('Phase 4. Verify target removed from hidden set');
    {
      if (targetAlreadyHidden) {
        console.log(
          `      ${DIM}target was in baseline — would need to re-add for full restore; skipping this check${RESET}`,
        );
      } else {
        const poll = await pollHidden(api, freshToken(), (body) =>
          Array.isArray(body?.data?.hidden)
            ? !body.data.hidden.includes(target)
            : false,
        );
        assert(
          'target absent from hidden set',
          poll.ok,
          poll.ok
            ? null
            : `last body: ${JSON.stringify(poll.body).slice(0, 400)}`,
        );
      }
    }
  } finally {
    // Safety cleanup — only fires if the explicit unhide in Phase 3
    // did not run or did not succeed. Idempotent on the server side
    // (unhiding an already-unhidden target is a no-op null-write).
    if (hideLatched) {
      console.log(
        `\n${YELLOW}safety unhide:${RESET} Phase 3 did not complete — issuing cleanup DELETE...`,
      );
      await safeUnhide(api, target, freshToken());
    }
  }

  console.log(
    `\n${passed + failed} checks — ${GREEN}${passed} passed${RESET}, ${
      failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed'
    }`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}Script failed:${RESET}`, err);
  process.exit(1);
});
