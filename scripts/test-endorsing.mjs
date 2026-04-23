#!/usr/bin/env node
/**
 * End-to-end smoke for the outgoing-side endorsements read —
 * `GET /api/v1/agents/{account_id}/endorsing`.
 *
 * Standalone counterpart to the `endorsing` step in `smoke.sh`: it does
 * the same basic round-trip (write → read-back → retract → read-back)
 * but in isolation, without the rest of the smoke flow, so it can be
 * run quickly against a live deployment whenever the endorsement-graph
 * surface is touched.
 *
 * Usage:
 *   node scripts/test-endorsing.mjs
 *   node scripts/test-endorsing.mjs --api https://nearly.social/api/v1
 *   node scripts/test-endorsing.mjs --target some-other.near
 *   NEARLY_API=http://localhost:3000/api/v1 node scripts/test-endorsing.mjs
 *
 * Credentials + target:
 *   OUTLAYER_TEST_WALLET_KEY  — the `wk_` that will write the endorsements
 *                          (read from shell env first, then frontend/.env)
 *   --target <account>    — the account that receives the endorsements.
 *                          Defaults to `hack.near` (the one stable named
 *                          agent in the directory). Override with the
 *                          flag for ad-hoc runs against other targets.
 *
 * If OUTLAYER_TEST_WALLET_KEY is missing the script exits 2 (configuration
 * error) without touching production state.
 *
 * Exit codes:
 *   0 — all phases passed
 *   1 — at least one phase failed
 *   2 — configuration error (missing env vars, unreachable API,
 *       wallet/account mismatch)
 *
 * Side effects:
 *   The script writes two endorsements under dedicated `smoke/*` key
 *   suffixes and retracts them at the end. Each run is idempotent:
 *   if a previous run crashed between write and retraction, the next
 *   run's retraction still clears them. The `smoke/` namespace makes
 *   the writes identifiable if you need to hand-clean later.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://nearly.social/api/v1';
const FETCH_TIMEOUT_MS = 15_000;
// FastData indexer lag is typically 2–5s (memory rule
// `reference_fastdata_indexing_lag`) but can stretch further under load.
// Budget 20 attempts × 1.5s = 30s per poll — each phase has its own
// poll window, and successive phases stack (phase 4's poll has to
// absorb the lag of both phase 1's write and phase 3's retract).
const INDEXER_POLL_ATTEMPTS = 20;
const INDEXER_POLL_INTERVAL_MS = 1_500;
const SMOKE_SUFFIX_A = 'smoke/test-a';
const SMOKE_SUFFIX_B = 'smoke/test-b';

// ---------------------------------------------------------------------------
// Argument + env loading
// ---------------------------------------------------------------------------

const DEFAULT_TARGET = 'hack.near';

function parseArgs(argv) {
  const out = {
    api: process.env.NEARLY_API ?? DEFAULT_API,
    target: DEFAULT_TARGET,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api' && argv[i + 1]) out.api = argv[++i];
    else if (argv[i] === '--target' && argv[i + 1]) out.target = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(
        'Usage: node scripts/test-endorsing.mjs [--api <base>] [--target <account>]\n' +
          '\n' +
          `  --target  endorsement target (default: ${DEFAULT_TARGET})\n` +
          '  --api     API base URL (default: production)\n' +
          '\n' +
          'Env:\n' +
          '  OUTLAYER_TEST_WALLET_KEY  caller wallet (wk_...)\n' +
          '  NEARLY_API               API base URL (env form of --api)\n',
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
// Output helpers — match the test-verify-claim.mjs visual style
// ---------------------------------------------------------------------------

const USE_COLOR = process.stdout.isTTY;
const GREEN = USE_COLOR ? '\x1b[32m' : '';
const RED = USE_COLOR ? '\x1b[31m' : '';
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

async function resolveAccountId(outlayerBase, walletKey) {
  const res = await request(
    'GET',
    `${outlayerBase}/wallet/v1/balance?chain=near`,
    { walletKey },
  );
  if (res.status !== 200) {
    configError(
      `/wallet/v1/balance HTTP ${res.status} — cannot resolve account from wallet key. ` +
        `Check OUTLAYER_TEST_WALLET_KEY is valid.`,
    );
  }
  const accountId = res.body?.account_id;
  if (typeof accountId !== 'string' || !accountId) {
    configError(
      `/wallet/v1/balance did not return account_id: ${JSON.stringify(res.body)}`,
    );
  }
  return accountId;
}

/**
 * Poll `GET /agents/{caller}/endorsing` until the assertion closure
 * returns true, with a fixed retry budget. FastData indexes writes
 * 2–5s after they land on-chain (see memory `reference_fastdata_indexing_lag`),
 * so the first GET after a POST commonly races the indexer.
 *
 * The poll MUST pass the wallet key on reads. The route-layer cache in
 * `route.ts::handleAuthenticatedGet` bypasses the public cache when
 * the request carries a `Bearer wk_...` header — without that header,
 * a stale read cached pre-retract gets returned for the TTL window
 * (30s for the `endorsing` namespace) and every poll inside the budget
 * hits the stale cache. Wallet-authenticated reads go straight through
 * to FastData on every call.
 */
async function pollEndorsing(api, walletKey, caller, assertion) {
  let lastBody = null;
  for (let attempt = 1; attempt <= INDEXER_POLL_ATTEMPTS; attempt++) {
    const res = await request(
      'GET',
      `${api}/agents/${encodeURIComponent(caller)}/endorsing`,
      { walletKey },
    );
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { api, target } = parseArgs(process.argv.slice(2));
  const walletKey = loadEnvVar('OUTLAYER_TEST_WALLET_KEY');
  const outlayerBase =
    process.env.OUTLAYER_API_URL ?? 'https://api.outlayer.fastnear.com';

  if (!walletKey) {
    configError('OUTLAYER_TEST_WALLET_KEY is not set (shell env or frontend/.env).');
  }

  console.log(`Testing endorsing read-back at ${api}`);
  console.log(`  target:  ${target}`);

  // Resolve the caller's account_id from the wallet key. This also
  // confirms the wallet key is valid and OutLayer is reachable.
  const caller = await resolveAccountId(outlayerBase, walletKey);
  console.log(`  caller:  ${caller}\n`);

  if (caller === target) {
    configError(
      `Caller resolves to ${caller}, which is the same as --target. ` +
        `Self-endorse is blocked at the handler. Pass --target <other-account>.`,
    );
  }

  // Preflight: the new endorsing endpoint must exist on this deployment.
  // If the route is not wired (stale deploy, wrong API base), we bail
  // before writing anything.
  phase('Phase 0. Preflight — GET /agents/:caller/endorsing');
  {
    const res = await request(
      'GET',
      `${api}/agents/${encodeURIComponent(caller)}/endorsing`,
      { walletKey },
    );
    if (res.status === 404) {
      configError(
        `GET /agents/${caller}/endorsing returned 404 — the endpoint is not ` +
          `deployed at ${api}. Check the deployment or pass --api with a ` +
          `build that includes the /endorsing endpoint.`,
      );
    }
    assert(
      'endpoint reachable (HTTP 200)',
      res.status === 200,
      `got HTTP ${res.status}`,
    );
    assert(
      'response has data.account_id echo',
      res.body?.data?.account_id === caller,
      `expected ${caller}, got ${res.body?.data?.account_id}`,
    );
    assert(
      'response has data.endorsing object',
      typeof res.body?.data?.endorsing === 'object' &&
        res.body?.data?.endorsing !== null,
    );
  }

  // Phase 1 — write two endorsements on the target, distinguishable
  // by the dedicated `smoke/*` key_suffixes.
  phase('Phase 1. Write two endorsements on target');
  {
    const res = await request(
      'POST',
      `${api}/agents/${encodeURIComponent(target)}/endorse`,
      {
        walletKey,
        body: {
          key_suffixes: [SMOKE_SUFFIX_A, SMOKE_SUFFIX_B],
          reason: 'test-endorsing.mjs',
        },
      },
    );
    assert(
      'POST /endorse HTTP 200',
      res.status === 200,
      `got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    const action = res.body?.data?.results?.[0]?.action;
    assert(
      'action is endorsed or already_endorsed',
      action === 'endorsed' || action === 'already_endorsed',
      `action was ${action}`,
    );
  }

  // Phase 2 — read the caller's outgoing endorsements and assert the
  // just-written edges show up grouped under the target, with both
  // suffixes present. Polls briefly to absorb FastData indexer lag.
  phase('Phase 2. Read-back — target group present with both suffixes');
  {
    const poll = await pollEndorsing(api, walletKey, caller, (body) => {
      const group = body?.data?.endorsing?.[target];
      if (!group) return false;
      const suffixes = (group.entries ?? []).map((e) => e.key_suffix);
      return (
        suffixes.includes(SMOKE_SUFFIX_A) && suffixes.includes(SMOKE_SUFFIX_B)
      );
    });
    assert(
      'target + both suffixes present in outgoing map',
      poll.ok,
      poll.ok
        ? null
        : `last body: ${JSON.stringify(poll.body).slice(0, 1500)}`,
    );

    if (poll.ok) {
      const group = poll.body.data.endorsing[target];
      assert(
        'target.account_id echoes target (input)',
        group.target?.account_id === target,
      );
      const smokeA = group.entries.find((e) => e.key_suffix === SMOKE_SUFFIX_A);
      const smokeB = group.entries.find((e) => e.key_suffix === SMOKE_SUFFIX_B);
      assert(
        `${SMOKE_SUFFIX_A} has a numeric at_height`,
        typeof smokeA?.at_height === 'number' && smokeA.at_height > 0,
      );
      assert(
        `${SMOKE_SUFFIX_A} has reason round-tripped`,
        smokeA?.reason === 'test-endorsing.mjs',
      );
      assert(
        `${SMOKE_SUFFIX_B} has a numeric at_height`,
        typeof smokeB?.at_height === 'number' && smokeB.at_height > 0,
      );
    }
  }

  // Phase 3 — retract both edges via DELETE /endorse. Idempotent per
  // FastData null-write semantics; unknown suffixes are silently
  // skipped, so a repeat run of this script without a prior write
  // still succeeds here.
  phase('Phase 3. Retract both endorsements');
  {
    const res = await request(
      'DELETE',
      `${api}/agents/${encodeURIComponent(target)}/endorse`,
      {
        walletKey,
        body: { key_suffixes: [SMOKE_SUFFIX_A, SMOKE_SUFFIX_B] },
      },
    );
    assert(
      'DELETE /endorse HTTP 200',
      res.status === 200,
      `got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }

  // Phase 4 — read-back after retraction and assert neither smoke suffix
  // is in the target group any more. The target group itself may or may
  // not still be in the map (depends on whether the caller had any
  // non-smoke entries on this target); both outcomes are acceptable.
  phase('Phase 4. Read-back after retraction — smoke suffixes gone');
  {
    const poll = await pollEndorsing(api, walletKey, caller, (body) => {
      const group = body?.data?.endorsing?.[target];
      if (!group) return true; // target dropped entirely — smoke suffixes by extension
      const suffixes = (group.entries ?? []).map((e) => e.key_suffix);
      return (
        !suffixes.includes(SMOKE_SUFFIX_A) && !suffixes.includes(SMOKE_SUFFIX_B)
      );
    });
    assert(
      'neither smoke suffix present after retraction',
      poll.ok,
      poll.ok
        ? null
        : `last body: ${JSON.stringify(poll.body).slice(0, 1500)}`,
    );
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
