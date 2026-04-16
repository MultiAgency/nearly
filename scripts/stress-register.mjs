#!/usr/bin/env node
/**
 * Minimal throughput probe for OutLayer `POST /register`.
 *
 * Spawns `CONCURRENCY` workers that loop POSTing to `/register` for
 * `DURATION_SECONDS` wall-clock seconds, records per-request latency,
 * and prints a single summary block at the end: totals, throughput,
 * p50/p95/p99, error bucket counts.
 *
 * Every successful request mints a real NEAR implicit account on
 * OutLayer's custody store. The script does NOT save the returned
 * `wk_` keys anywhere — created wallets are accepted as litter by
 * design. If you need to capture them, do it outside this script.
 *
 * Usage:
 *   node scripts/stress-register.mjs
 *   DURATION_SECONDS=10 CONCURRENCY=3 node scripts/stress-register.mjs
 *   OUTLAYER_API=https://staging.example node scripts/stress-register.mjs
 *
 * Env:
 *   DURATION_SECONDS   wall-clock budget (default: 30)
 *   CONCURRENCY        max in-flight requests (default: 10)
 *   OUTLAYER_API       base URL (default: https://api.outlayer.fastnear.com)
 *
 * Exit codes:
 *   0 — run completed (successful or not — the summary is the payload)
 *   1 — invalid configuration (bad env var)
 *
 * Ctrl-C is honored: the deadline collapses, in-flight requests abort
 * via their per-request timeout, and the summary prints with whatever
 * was captured so far.
 */

const DEFAULT_OUTLAYER_API = 'https://api.outlayer.fastnear.com';
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_CONCURRENCY = 10;
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Args + env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/stress-register.mjs\n' +
          '\n' +
          'Env:\n' +
          `  DURATION_SECONDS   wall-clock budget (default: ${DEFAULT_DURATION_SECONDS})\n` +
          `  CONCURRENCY        max in-flight requests (default: ${DEFAULT_CONCURRENCY})\n` +
          `  OUTLAYER_API       base URL (default: ${DEFAULT_OUTLAYER_API})\n` +
          '\n' +
          'Every successful request mints a real implicit NEAR account\n' +
          'on OutLayer. The script saves no wallet keys. Start small.\n',
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
      `stress-register: ${name} must be a positive integer (got "${raw}")`,
    );
    process.exit(1);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const USE_COLOR = process.stdout.isTTY;
const DIM = USE_COLOR ? '\x1b[2m' : '';
const BOLD = USE_COLOR ? '\x1b[1m' : '';
const RESET = USE_COLOR ? '\x1b[0m' : '';

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

async function registerOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(url, { method: 'POST', signal: ctrl.signal });
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

async function worker(state) {
  while (Date.now() < state.deadline) {
    const result = await registerOnce(state.url);
    if (result.ok) {
      state.successLatencies.push(result.latency);
      state.successes += 1;
    } else {
      const bucket = String(result.status);
      state.errorBuckets[bucket] = (state.errorBuckets[bucket] ?? 0) + 1;
      state.errors += 1;
    }
    state.totals += 1;
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  // Nearest-rank: rank = ceil(p * N), 1-indexed → 0-indexed clamp.
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
  const base = process.env.OUTLAYER_API ?? DEFAULT_OUTLAYER_API;
  const url = `${base.replace(/\/$/, '')}/register`;

  console.log(`${BOLD}stress-register.mjs${RESET}`);
  console.log(`${DIM}target:${RESET}      ${url}`);
  console.log(`${DIM}duration:${RESET}    ${durationSeconds}s`);
  console.log(`${DIM}concurrency:${RESET} ${concurrency}`);
  console.log('');
  console.log(
    `${DIM}Every successful request mints a real implicit NEAR account. Ctrl-C to abort.${RESET}`,
  );
  console.log('');

  const state = {
    url,
    deadline: Date.now() + durationSeconds * 1000,
    totals: 0,
    successes: 0,
    errors: 0,
    successLatencies: [],
    errorBuckets: {},
  };

  // Ctrl-C collapses the deadline. In-flight requests still honor
  // their per-request abort timeout, so workers return promptly.
  const onSigint = () => {
    state.deadline = 0;
    console.log(`\n${DIM}SIGINT — draining and printing summary${RESET}`);
  };
  process.once('SIGINT', onSigint);

  const startWall = performance.now();
  const workers = Array.from({ length: concurrency }, () => worker(state));
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
}

main().catch((err) => {
  console.error(`stress-register: ${err?.message ?? err}`);
  process.exit(1);
});
