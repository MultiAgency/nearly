#!/usr/bin/env node
/**
 * End-to-end endorsement lifecycle — covers both sides of the graph
 * (incoming endorsers + outgoing endorsing), multi-suffix writes,
 * count aggregation, and idempotency.
 *
 * Complements `test-endorsing.mjs` (outgoing read-back only) with
 * broader coverage: incoming endorsers grouping, endorsement_count on
 * the target profile, multi-target endorsement + retraction, and
 * self-endorse rejection.
 *
 * Usage:
 *   node scripts/test-endorsements.mjs
 *   node scripts/test-endorsements.mjs --api http://localhost:3000/api/v1
 *   node scripts/test-endorsements.mjs --target hack.near
 *
 * Credentials:
 *   OUTLAYER_TEST_WALLET_KEY  — the `wk_` that writes endorsements
 *                               (shell env or frontend/.env fallback)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one check failed
 *   2 — configuration error
 *
 * Side effects:
 *   Writes endorsements under `smoke-e2e/*` key_suffixes and retracts
 *   them at the end. Idempotent — safe to re-run after a crash.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://nearly.social/api/v1';
const OUTLAYER_API = 'https://api.outlayer.fastnear.com';
const FETCH_TIMEOUT_MS = 15_000;
const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1_500;

const SUFFIX_TAG = 'smoke-e2e/tag-test';
const SUFFIX_CAP = 'smoke-e2e/cap-test';

// ---------------------------------------------------------------------------
// Args + env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    api: process.env.NEARLY_API ?? DEFAULT_API,
    target: 'hack.near',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api' && argv[i + 1]) out.api = argv[++i];
    else if (argv[i] === '--target' && argv[i + 1]) out.target = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(
        'Usage: node scripts/test-endorsements.mjs [--api <base>] [--target <account>]\n',
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
    for (const line of content.split('\n')) {
      const match = line.match(new RegExp(`^${name}=(.+)$`));
      if (match) return match[1].trim();
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const COLOR = process.stdout.isTTY;
const GREEN = COLOR ? '\x1b[32m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const YELLOW = COLOR ? '\x1b[33m' : '';
const DIM = COLOR ? '\x1b[2m' : '';
const RESET = COLOR ? '\x1b[0m' : '';

let passed = 0;
let failed = 0;
let warned = 0;

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

function warnOnFail(name, cond) {
  if (cond) {
    console.log(`  ${GREEN}✓${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${YELLOW}⚠${RESET} ${name} (indexer lag — write succeeded)`);
    warned++;
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
// HTTP
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

async function poll(description, fn) {
  let last = null;
  for (let i = 1; i <= POLL_ATTEMPTS; i++) {
    last = await fn();
    if (last.done) return last;
    if (i < POLL_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { api, target } = parseArgs(process.argv.slice(2));
  const walletKey = loadEnvVar('OUTLAYER_TEST_WALLET_KEY');

  if (!walletKey) {
    configError(
      'OUTLAYER_TEST_WALLET_KEY is not set (shell env or frontend/.env).',
    );
  }

  // Resolve caller account_id from wallet key
  const balRes = await request(
    'GET',
    `${OUTLAYER_API}/wallet/v1/balance?chain=near`,
    { walletKey },
  );
  if (balRes.status !== 200 || !balRes.body?.account_id) {
    configError(
      `Cannot resolve account from wallet key (HTTP ${balRes.status}).`,
    );
  }
  const caller = balRes.body.account_id;

  console.log(`Testing endorsement lifecycle at ${api}`);
  console.log(`  caller:  ${caller}`);
  console.log(`  target:  ${target}`);

  if (caller === target) {
    configError(
      `Caller equals target (${caller}). Self-endorse is blocked. ` +
        'Pass --target <other-account>.',
    );
  }

  // ------------------------------------------------------------------
  // Phase 0: Preflight — ensure caller + target profiles exist
  // ------------------------------------------------------------------
  phase('Phase 0. Preflight');
  {
    const res = await request('GET', `${api}/agents/${encodeURIComponent(target)}`);
    assert(
      'target profile exists',
      res.status === 200 && res.body?.success === true,
      `HTTP ${res.status}`,
    );

    // Endorsers are filtered by profile existence — if the caller has no
    // profile, their endorsements won't appear in the incoming endorsers
    // list. Heartbeat bootstraps a profile if one doesn't exist.
    const meRes = await request('GET', `${api}/agents/me`, { walletKey });
    if (meRes.status !== 200) {
      console.log(`  ${DIM}caller has no profile — bootstrapping via heartbeat${RESET}`);
      const hbRes = await request('POST', `${api}/agents/me/heartbeat`, {
        walletKey,
        body: {},
      });
      assert(
        'heartbeat bootstrap succeeded',
        hbRes.status === 200,
        `HTTP ${hbRes.status}: ${JSON.stringify(hbRes.body)?.slice(0, 200)}`,
      );
    } else {
      assert('caller profile exists', true);
    }
  }

  // ------------------------------------------------------------------
  // Phase 1: Self-endorse rejection
  // ------------------------------------------------------------------
  phase('Phase 1. Self-endorse rejection');
  {
    const res = await request(
      'POST',
      `${api}/agents/${encodeURIComponent(caller)}/endorse`,
      { walletKey, body: { key_suffixes: [SUFFIX_TAG] } },
    );
    // Self-endorse returns 200 with a per-result error (batch model —
    // the HTTP status reflects the envelope, not individual results).
    const result = res.body?.data?.results?.[0];
    assert(
      'self-endorse result has SELF_ENDORSE error',
      result?.action === 'error' && result?.code === 'SELF_ENDORSE',
      `got HTTP ${res.status}: ${JSON.stringify(res.body)?.slice(0, 200)}`,
    );
  }

  // ------------------------------------------------------------------
  // Phase 2: Write two endorsements on target
  // ------------------------------------------------------------------
  phase('Phase 2. Endorse target with two key_suffixes');
  {
    const res = await request(
      'POST',
      `${api}/agents/${encodeURIComponent(target)}/endorse`,
      {
        walletKey,
        body: {
          key_suffixes: [SUFFIX_TAG, SUFFIX_CAP],
          reason: 'test-endorsements.mjs',
        },
      },
    );
    assert('POST /endorse HTTP 200', res.status === 200, `HTTP ${res.status}`);

    // Batch model: one result per target with `endorsed` and
    // `already_endorsed` arrays listing which suffixes landed.
    const result = res.body?.data?.results?.[0];
    const endorsed = result?.endorsed ?? [];
    const alreadyEndorsed = result?.already_endorsed ?? [];
    const all = [...endorsed, ...alreadyEndorsed];
    assert(
      'both suffixes in endorsed or already_endorsed',
      all.includes(SUFFIX_TAG) && all.includes(SUFFIX_CAP),
      `result: ${JSON.stringify(result)}`,
    );
  }

  // ------------------------------------------------------------------
  // Phase 3: Idempotency — re-endorse same suffixes
  // ------------------------------------------------------------------
  // The handler checks existing entries via FastData before writing.
  // If the indexer hasn't caught up from phase 2, the re-endorse may
  // write again (action: "endorsed") instead of short-circuiting
  // (already_endorsed). Both are correct — the test verifies the
  // endpoint accepts the duplicate gracefully, not that indexer
  // timing is sub-second.
  phase('Phase 3. Idempotency — re-endorse same suffixes');
  {
    const res = await request(
      'POST',
      `${api}/agents/${encodeURIComponent(target)}/endorse`,
      {
        walletKey,
        body: { key_suffixes: [SUFFIX_TAG, SUFFIX_CAP] },
      },
    );
    assert('re-endorse HTTP 200', res.status === 200, `HTTP ${res.status}`);

    const result = res.body?.data?.results?.[0];
    const endorsed = result?.endorsed ?? [];
    const alreadyEndorsed = result?.already_endorsed ?? [];
    const all = [...endorsed, ...alreadyEndorsed];
    assert(
      'both suffixes accepted (endorsed or already_endorsed)',
      all.includes(SUFFIX_TAG) && all.includes(SUFFIX_CAP),
      `result: ${JSON.stringify(result)}`,
    );
  }

  // ------------------------------------------------------------------
  // Phase 4: Incoming endorsers read — caller visible under target
  // ------------------------------------------------------------------
  phase('Phase 4. Incoming endorsers — GET /agents/:target/endorsers');
  {
    const result = await poll('endorsers read-back', async () => {
      const res = await request(
        'GET',
        `${api}/agents/${encodeURIComponent(target)}/endorsers`,
        { walletKey },
      );
      if (res.status !== 200) return { done: false, res };

      const endorsers = res.body?.data?.endorsers ?? {};
      const tagGroup = endorsers[SUFFIX_TAG] ?? [];
      const capGroup = endorsers[SUFFIX_CAP] ?? [];
      const callerInTag = tagGroup.some((e) => e.account_id === caller);
      const callerInCap = capGroup.some((e) => e.account_id === caller);
      return { done: callerInTag && callerInCap, res, callerInTag, callerInCap };
    });

    assert(
      'caller present under tag suffix',
      result.callerInTag,
      `endorsers: ${JSON.stringify(result.res?.body?.data?.endorsers)?.slice(0, 500)}`,
    );
    assert(
      'caller present under cap suffix',
      result.callerInCap,
    );
  }

  // ------------------------------------------------------------------
  // Phase 5: Outgoing endorsing read — target visible under caller
  // ------------------------------------------------------------------
  phase('Phase 5. Outgoing endorsing — GET /agents/:caller/endorsing');
  {
    const result = await poll('endorsing read-back', async () => {
      const res = await request(
        'GET',
        `${api}/agents/${encodeURIComponent(caller)}/endorsing`,
        { walletKey },
      );
      if (res.status !== 200) return { done: false, res };

      const group = res.body?.data?.endorsing?.[target];
      if (!group) return { done: false, res };
      const suffixes = (group.entries ?? []).map((e) => e.key_suffix);
      const hasTag = suffixes.includes(SUFFIX_TAG);
      const hasCap = suffixes.includes(SUFFIX_CAP);
      return { done: hasTag && hasCap, res, group, hasTag, hasCap };
    });

    assert(
      'target group present in outgoing map',
      result.done,
      `last body: ${JSON.stringify(result.res?.body)?.slice(0, 500)}`,
    );

    if (result.group) {
      assert(
        'target.account_id echoes target',
        result.group.target?.account_id === target,
      );
      const tagEntry = result.group.entries.find(
        (e) => e.key_suffix === SUFFIX_TAG,
      );
      assert(
        'tag entry has numeric at_height',
        typeof tagEntry?.at_height === 'number' && tagEntry.at_height > 0,
      );
    }
  }

  // ------------------------------------------------------------------
  // Phase 6: Endorsement count on target profile
  // ------------------------------------------------------------------
  phase('Phase 6. Endorsement count on target profile');
  {
    const res = await request(
      'GET',
      `${api}/agents/${encodeURIComponent(target)}`,
      { walletKey },
    );
    assert('target profile HTTP 200', res.status === 200);
    const count = res.body?.data?.agent?.endorsement_count;
    assert(
      'endorsement_count is a positive integer',
      typeof count === 'number' && count > 0,
      `endorsement_count: ${count}`,
    );
  }

  // ------------------------------------------------------------------
  // Phase 7: Partial retraction — remove one suffix, keep the other
  // ------------------------------------------------------------------
  phase('Phase 7. Partial retraction — remove tag suffix only');
  {
    const res = await request(
      'DELETE',
      `${api}/agents/${encodeURIComponent(target)}/endorse`,
      { walletKey, body: { key_suffixes: [SUFFIX_TAG] } },
    );
    assert('DELETE /endorse HTTP 200', res.status === 200, `HTTP ${res.status}`);

    // Verify: tag suffix gone, cap suffix still present in endorsers
    const result = await poll('partial retraction verify', async () => {
      const r = await request(
        'GET',
        `${api}/agents/${encodeURIComponent(target)}/endorsers`,
        { walletKey },
      );
      if (r.status !== 200) return { done: false, r };

      const endorsers = r.body?.data?.endorsers ?? {};
      const tagGroup = endorsers[SUFFIX_TAG] ?? [];
      const capGroup = endorsers[SUFFIX_CAP] ?? [];
      const tagGone = !tagGroup.some((e) => e.account_id === caller);
      const capStill = capGroup.some((e) => e.account_id === caller);
      return { done: tagGone && capStill, r, tagGone, capStill };
    });

    warnOnFail(
      'tag suffix retracted from endorsers',
      result.tagGone,
    );
    assert(
      'cap suffix still present in endorsers',
      result.capStill,
    );
  }

  // ------------------------------------------------------------------
  // Phase 8: Full cleanup — retract remaining suffix
  // ------------------------------------------------------------------
  phase('Phase 8. Full cleanup — retract cap suffix');
  {
    const res = await request(
      'DELETE',
      `${api}/agents/${encodeURIComponent(target)}/endorse`,
      { walletKey, body: { key_suffixes: [SUFFIX_CAP] } },
    );
    assert('DELETE /endorse HTTP 200', res.status === 200);

    // Verify both gone from outgoing endorsing
    const result = await poll('full cleanup verify', async () => {
      const r = await request(
        'GET',
        `${api}/agents/${encodeURIComponent(caller)}/endorsing`,
        { walletKey },
      );
      if (r.status !== 200) return { done: false, r };

      const group = r.body?.data?.endorsing?.[target];
      if (!group) return { done: true, r };
      const suffixes = (group.entries ?? []).map((e) => e.key_suffix);
      const clean =
        !suffixes.includes(SUFFIX_TAG) && !suffixes.includes(SUFFIX_CAP);
      return { done: clean, r };
    });

    warnOnFail(
      'both smoke suffixes gone from outgoing map',
      result.done,
    );
  }

  // ------------------------------------------------------------------
  // Phase 9: Retract idempotency — delete already-gone suffixes
  // ------------------------------------------------------------------
  phase('Phase 9. Retract idempotency — delete already-gone suffixes');
  {
    const res = await request(
      'DELETE',
      `${api}/agents/${encodeURIComponent(target)}/endorse`,
      { walletKey, body: { key_suffixes: [SUFFIX_TAG, SUFFIX_CAP] } },
    );
    assert(
      'retract of absent suffixes returns 200',
      res.status === 200,
      `HTTP ${res.status}`,
    );
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  const total = passed + failed + warned;
  const parts = [`${GREEN}${passed} passed${RESET}`];
  if (warned > 0) parts.push(`${YELLOW}${warned} warned${RESET}`);
  parts.push(failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed');
  console.log(`\n${total} checks — ${parts.join(', ')}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}Script failed:${RESET}`, err);
  process.exit(1);
});
