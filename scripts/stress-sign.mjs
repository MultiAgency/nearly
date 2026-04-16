#!/usr/bin/env node
/**
 * Minimal throughput probe for OutLayer `POST /wallet/v1/sign-message`.
 *
 * Spawns `CONCURRENCY` workers that loop POSTing to `/wallet/v1/sign-message`
 * with a fresh NEP-413 inner message each request, using a single `wk_`
 * loaded from shell env or `frontend/.env`. Records per-request latency
 * and prints a single summary block at the end.
 *
 * Signing writes nothing. No wallets minted, no graph edges, no FastData
 * state. The only external effect is load on OutLayer's signing endpoint.
 * Cleanest blast-radius stress probe in this repo.
 *
 * Usage:
 *   node scripts/stress-sign.mjs
 *   DURATION_SECONDS=10 CONCURRENCY=3 node scripts/stress-sign.mjs
 *   OUTLAYER_API=https://staging.example node scripts/stress-sign.mjs
 *
 * Env:
 *   DURATION_SECONDS      wall-clock budget (default: 30)
 *   CONCURRENCY           max in-flight requests (default: 10)
 *   OUTLAYER_API          base URL (default: https://api.outlayer.fastnear.com)
 *   OUTLAYER_TEST_WALLET_KEY   single caller wk_ (shell env or frontend/.env fallback)
 *   OUTLAYER_WALLET_KEYS  comma-separated caller wk_'s for cross-caller shape
 *                         (overrides OUTLAYER_TEST_WALLET_KEY when set; workers are
 *                         assigned round-robin across the pool)
 *
 * Exit codes:
 *   0 — run completed (summary is the payload)
 *   1 — invalid configuration (bad env var, missing wk_, preflight failure)
 *
 * Ctrl-C is honored: the deadline collapses, in-flight requests abort via
 * their per-request timeout, and the summary prints whatever was captured.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTLAYER_API = 'https://api.outlayer.fastnear.com';
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_CONCURRENCY = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const RECIPIENT = 'nearly.social';

// ---------------------------------------------------------------------------
// Args + env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/stress-sign.mjs\n' +
          '\n' +
          'Env:\n' +
          `  DURATION_SECONDS      wall-clock budget (default: ${DEFAULT_DURATION_SECONDS})\n` +
          `  CONCURRENCY           max in-flight requests (default: ${DEFAULT_CONCURRENCY})\n` +
          `  OUTLAYER_API          base URL (default: ${DEFAULT_OUTLAYER_API})\n` +
          '  OUTLAYER_TEST_WALLET_KEY   single caller wk_ (shell env or frontend/.env fallback)\n' +
          '  OUTLAYER_WALLET_KEYS  comma-separated wk_ pool for cross-caller shape\n' +
          '\n' +
          'No writes. No wallets minted. Pure load on OutLayer sign-message.\n',
      );
      process.exit(0);
    }
  }
}

function parsePositiveInt(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(
      `stress-sign: ${name} must be a positive integer (got "${raw}")`,
    );
    process.exit(1);
  }
  return n;
}

function parseKeyList(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the caller pool.
 *
 * Priority: `OUTLAYER_WALLET_KEYS` (comma-separated) wins if set, for the
 * cross-caller shape. Otherwise falls back to single-caller via
 * `OUTLAYER_TEST_WALLET_KEY` (shell env, then `frontend/.env`). Returns an
 * array of non-empty wk_ strings, or an empty array if none resolved.
 */
function loadWalletKeys() {
  if (process.env.OUTLAYER_WALLET_KEYS) {
    return parseKeyList(process.env.OUTLAYER_WALLET_KEYS);
  }
  if (process.env.OUTLAYER_TEST_WALLET_KEY) return [process.env.OUTLAYER_TEST_WALLET_KEY];
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const envPath = join(scriptDir, '..', 'frontend', '.env');
    if (!existsSync(envPath)) return [];
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^OUTLAYER_TEST_WALLET_KEY=(.+)$/);
      if (match) return [match[1].trim()];
    }
  } catch {}
  return [];
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const USE_COLOR = process.stdout.isTTY;
const DIM = USE_COLOR ? '\x1b[2m' : '';
const BOLD = USE_COLOR ? '\x1b[1m' : '';
const RESET = USE_COLOR ? '\x1b[0m' : '';

// ---------------------------------------------------------------------------
// NEP-413 inner-message + sign-message call
// ---------------------------------------------------------------------------

function buildInnerMessage(accountId) {
  return JSON.stringify({
    action: 'stress',
    domain: RECIPIENT,
    account_id: accountId,
    version: 1,
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('base64'),
  });
}

async function resolveAccountId(base, walletKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/wallet/v1/balance?chain=near`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${walletKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`balance preflight HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    if (typeof body?.account_id !== 'string' || !body.account_id) {
      throw new Error(`balance response missing account_id: ${JSON.stringify(body)}`);
    }
    return body.account_id;
  } finally {
    clearTimeout(timer);
  }
}

async function signOnce(url, walletKey, accountId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const body = JSON.stringify({
    message: buildInnerMessage(accountId),
    recipient: RECIPIENT,
  });
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${walletKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: ctrl.signal,
    });
    const latency = performance.now() - start;
    return { ok: res.ok, status: res.status, latency };
  } catch (err) {
    const latency = performance.now() - start;
    return {
      ok: false,
      status: 'network',
      latency,
      reason: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function worker(state, callerIndex) {
  const caller = state.callers[callerIndex];
  while (Date.now() < state.deadline) {
    const result = await signOnce(state.url, caller.walletKey, caller.accountId);
    caller.totals += 1;
    state.totals += 1;
    if (result.ok) {
      caller.successes += 1;
      caller.successLatencies.push(result.latency);
      state.successes += 1;
      state.successLatencies.push(result.latency);
    } else {
      const bucket = String(result.status);
      caller.errors += 1;
      caller.errorBuckets[bucket] = (caller.errorBuckets[bucket] ?? 0) + 1;
      state.errors += 1;
      state.errorBuckets[bucket] = (state.errorBuckets[bucket] ?? 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAsc.length));
  return sortedAsc[rank - 1];
}

function formatMs(v) {
  return v === null ? '—' : `${Math.round(v)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  parseArgs(process.argv.slice(2));

  const durationSeconds = parsePositiveInt(
    'DURATION_SECONDS',
    process.env.DURATION_SECONDS,
    DEFAULT_DURATION_SECONDS,
  );
  const concurrency = parsePositiveInt(
    'CONCURRENCY',
    process.env.CONCURRENCY,
    DEFAULT_CONCURRENCY,
  );
  const base = (process.env.OUTLAYER_API ?? DEFAULT_OUTLAYER_API).replace(/\/$/, '');
  const url = `${base}/wallet/v1/sign-message`;

  const walletKeys = loadWalletKeys();
  if (walletKeys.length === 0) {
    console.error(
      'stress-sign: no caller keys resolved (set OUTLAYER_TEST_WALLET_KEY, OUTLAYER_WALLET_KEYS, or frontend/.env)',
    );
    process.exit(1);
  }

  // Preflight: resolve account_id for every caller before spraying
  // sign-message. Fails fast on any bad auth or unreachable base — a
  // misconfigured key should not silently drop from the pool.
  const callers = [];
  for (let i = 0; i < walletKeys.length; i++) {
    try {
      const accountId = await resolveAccountId(base, walletKeys[i]);
      callers.push({
        walletKey: walletKeys[i],
        accountId,
        totals: 0,
        successes: 0,
        errors: 0,
        successLatencies: [],
        errorBuckets: {},
      });
    } catch (err) {
      console.error(
        `stress-sign: preflight failed for caller #${i + 1} — ${err.message}`,
      );
      process.exit(1);
    }
  }

  console.log(`${BOLD}stress-sign.mjs${RESET}`);
  console.log(`${DIM}target:${RESET}      ${url}`);
  if (callers.length === 1) {
    console.log(`${DIM}caller:${RESET}      ${callers[0].accountId}`);
  } else {
    console.log(`${DIM}callers:${RESET}     ${callers.length}`);
    callers.forEach((c, i) => {
      console.log(`  ${DIM}#${i + 1}:${RESET}        ${c.accountId}`);
    });
  }
  console.log(`${DIM}duration:${RESET}    ${durationSeconds}s`);
  console.log(`${DIM}concurrency:${RESET} ${concurrency}`);
  console.log('');
  console.log(
    `${DIM}No writes. Pure load on OutLayer sign-message. Ctrl-C to abort.${RESET}`,
  );
  console.log('');

  const state = {
    url,
    callers,
    deadline: Date.now() + durationSeconds * 1000,
    totals: 0,
    successes: 0,
    errors: 0,
    successLatencies: [],
    errorBuckets: {},
  };

  const onSigint = () => {
    state.deadline = 0;
    console.log(`\n${DIM}SIGINT — draining and printing summary${RESET}`);
  };
  process.once('SIGINT', onSigint);

  const startWall = performance.now();
  // Round-robin assignment of workers to callers. Each worker owns one
  // (wk_, account_id) pair for the entire run; per-caller rate-limit
  // buckets are independent, so spreading workers across callers is
  // what makes this the cross-caller shape.
  const workers = Array.from({ length: concurrency }, (_, i) =>
    worker(state, i % callers.length),
  );
  await Promise.all(workers);
  const elapsedSeconds = (performance.now() - startWall) / 1000;

  process.removeListener('SIGINT', onSigint);

  // ── Summary ──────────────────────────────────────────────────────────────
  const sorted = state.successLatencies.slice().sort((a, b) => a - b);
  const throughput = state.totals / elapsedSeconds;

  console.log(`${BOLD}results${RESET}`);
  console.log(`${DIM}elapsed:${RESET}    ${elapsedSeconds.toFixed(2)}s`);
  console.log(`${DIM}total:${RESET}      ${state.totals}`);
  console.log(`${DIM}successful:${RESET} ${state.successes}`);
  console.log(`${DIM}errors:${RESET}     ${state.errors}`);
  for (const [bucket, count] of Object.entries(state.errorBuckets)) {
    console.log(`  ${bucket}:${' '.repeat(Math.max(1, 10 - bucket.length))}${count}`);
  }
  console.log('');
  console.log(`${DIM}throughput:${RESET} ${throughput.toFixed(2)} req/sec`);
  console.log(`${DIM}latency (ms):${RESET}`);
  console.log(`  p50:       ${formatMs(percentile(sorted, 50))}`);
  console.log(`  p95:       ${formatMs(percentile(sorted, 95))}`);
  console.log(`  p99:       ${formatMs(percentile(sorted, 99))}`);

  // ── Per-caller breakdown (only when the pool has >1 caller) ────────────
  if (callers.length > 1) {
    console.log('');
    console.log(`${BOLD}per-caller${RESET}`);
    callers.forEach((c, i) => {
      const callerSorted = c.successLatencies.slice().sort((a, b) => a - b);
      const callerThroughput = c.successes / elapsedSeconds;
      const p50 = formatMs(percentile(callerSorted, 50));
      const successRate =
        c.totals > 0 ? ((c.successes / c.totals) * 100).toFixed(1) : '—';
      const errorSummary =
        Object.keys(c.errorBuckets).length === 0
          ? ''
          : ` (${Object.entries(c.errorBuckets)
              .map(([b, n]) => `${b}:${n}`)
              .join(' ')})`;
      console.log(
        `  #${i + 1} ${c.accountId.slice(0, 12)}…  ` +
          `total=${c.totals} ok=${c.successes} (${successRate}%)  ` +
          `${callerThroughput.toFixed(2)}/s  p50=${p50}ms${errorSummary}`,
      );
    });
  }
}

main().catch((err) => {
  console.error(`stress-sign: ${err?.message ?? err}`);
  process.exit(1);
});
