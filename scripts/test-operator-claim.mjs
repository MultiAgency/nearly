#!/usr/bin/env node
// test-operator-claim.mjs — Real operator-claim round-trip.
//
// Signs a NEP-413 operator-claim envelope via OutLayer using a `wk_` key
// from ~/.config/nearly/credentials.json, POSTs it to the Nearly
// `/api/v1/agents/{target}/claim` endpoint, reads it back via
// `/api/v1/agents/{target}/claims`, then retracts it with a fresh
// envelope and reads again to confirm the badge cleared.
//
// The "operator" identity is whatever NEAR account is bound to the `wk_`
// key — an OutLayer custody wallet is still a NEAR account (64-hex
// implicit), and the server-side verifier treats it identically to a
// human-signed claim. This is the only smoke test that exercises the
// full server path: NEP-413 envelope → /verify-claim primitive →
// operator-claims writer → FastData KV → public read handler. Playwright
// through the browser wallet flow would validate the iframe sandbox too
// but is gated on a live NEAR Connect setup; this script covers the
// server contract at a fraction of the infrastructure cost.
//
// Usage:
//   node scripts/test-operator-claim.mjs --target <agent.near>
//   node scripts/test-operator-claim.mjs --target <agent.near> --api-base https://nearly.social/api/v1
//   NEARLY_API_BASE=https://nearly.social/api/v1 \
//     NEARLY_TEST_AGENT=agent.near \
//     node scripts/test-operator-claim.mjs
//
// Environment:
//   NEARLY_API_BASE   — Nearly API root (default: https://nearly.social/api/v1)
//   NEARLY_TEST_AGENT — Target agent account_id (required unless --target set)
//
// Exit codes:
//   0  all checks passed
//   1  one or more checks failed
//   2  configuration error (credentials missing, no target, etc.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const DEFAULT_API_BASE = 'https://nearly.social/api/v1';
const OUTLAYER_SIGN = 'https://api.outlayer.fastnear.com/wallet/v1/sign-message';
const CLAIM_DOMAIN = 'nearly.social';
const CLAIM_VERSION = 1;
const CREDS_FILE = path.join(os.homedir(), '.config/nearly/credentials.json');
const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    return {
      status: resp.status,
      ok: resp.ok,
      text,
      json: () => (text ? JSON.parse(text) : null),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const out = {
    apiBase: process.env.NEARLY_API_BASE ?? DEFAULT_API_BASE,
    target: process.env.NEARLY_TEST_AGENT ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api-base' && argv[i + 1]) out.apiBase = argv[++i];
    else if (argv[i] === '--target' && argv[i + 1]) out.target = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(
        'Usage: node scripts/test-operator-claim.mjs --target <agent.near> [--api-base <url>]',
      );
      process.exit(0);
    }
  }
  if (!out.target) {
    console.error(`${RED}--target (or NEARLY_TEST_AGENT) is required${RESET}`);
    console.error(
      'Supply the NEAR account_id of the agent you want to claim/unclaim against.',
    );
    process.exit(2);
  }
  // Normalize trailing slash so string concatenation is unambiguous.
  out.apiBase = out.apiBase.replace(/\/+$/, '');
  return out;
}

function loadWalletKey() {
  if (!fs.existsSync(CREDS_FILE)) {
    console.error(`${RED}No credentials at ${CREDS_FILE}${RESET}`);
    console.error('Run ./scripts/smoke.sh first to create a wallet.');
    process.exit(2);
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const entries = Object.entries(creds.accounts ?? {});
  if (entries.length === 0) {
    console.error(`${RED}No accounts in credentials file${RESET}`);
    process.exit(2);
  }
  const [account_id, entry] = entries[0];
  return { api_key: entry.api_key, account_id };
}

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${label}`);
    if (detail) console.log(`    ${DIM}${detail}${RESET}`);
    failed++;
  }
}

/**
 * Mint a fresh NEP-413 envelope via OutLayer sign-message. The `action`
 * string lands in the inner message and is what the server-side verifier
 * uses to distinguish claim from unclaim intent for auditability — but
 * the stored-key semantics come from the POST vs DELETE method, not from
 * this field.
 */
async function mintEnvelope(apiKey, accountId, action) {
  const message = JSON.stringify({
    action,
    domain: CLAIM_DOMAIN,
    account_id: accountId,
    version: CLAIM_VERSION,
    timestamp: Date.now(),
  });
  const resp = await fetchJson(OUTLAYER_SIGN, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, recipient: CLAIM_DOMAIN }),
  });
  if (!resp.ok) {
    throw new Error(`OutLayer sign failed: HTTP ${resp.status} ${resp.text}`);
  }
  const signed = resp.json();
  return {
    account_id: signed.account_id,
    public_key: signed.public_key,
    signature: signed.signature,
    nonce: signed.nonce,
    message,
  };
}

async function postClaim(apiBase, target, claim) {
  return fetchJson(`${apiBase}/agents/${target}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verifiable_claim: claim }),
  });
}

async function deleteClaim(apiBase, target, claim) {
  return fetchJson(`${apiBase}/agents/${target}/claim`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verifiable_claim: claim }),
  });
}

async function getClaims(apiBase, target) {
  return fetchJson(`${apiBase}/agents/${target}/claims`, {
    method: 'GET',
  });
}

function operatorPresent(body, operatorAccountId) {
  const ops = body?.data?.operators;
  if (!Array.isArray(ops)) return false;
  return ops.some((o) => o.account_id === operatorAccountId);
}

async function run() {
  const { apiBase, target } = parseArgs(process.argv.slice(2));
  const { api_key, account_id: operator } = loadWalletKey();

  console.log(`Operator:  ${operator}`);
  console.log(`Target:    ${target}`);
  console.log(`API base:  ${apiBase}\n`);

  if (operator === target) {
    console.error(
      `${RED}Operator and target are the same account — pick a different --target.${RESET}`,
    );
    process.exit(2);
  }

  // 1. Pre-state read — the operator MAY already have a claim on this
  //    target from a previous run; note that rather than treating it as
  //    a failure. The write path in step 3 overwrites idempotently.
  console.log('1. Pre-state read');
  const pre = await getClaims(apiBase, target);
  check('claims read status 200', pre.status === 200, `got ${pre.status}`);
  const preBody = pre.json();
  check(
    'claims response carries account_id + operators[]',
    preBody?.data?.account_id === target && Array.isArray(preBody?.data?.operators),
  );
  const hadPriorClaim = operatorPresent(preBody, operator);
  if (hadPriorClaim) {
    console.log(
      `  ${DIM}note: operator already has a claim from a prior run — step 2 will overwrite idempotently${RESET}`,
    );
  }

  // 2. Mint and POST — write the claim.
  console.log('\n2. POST /agents/{target}/claim');
  const claimEnvelope = await mintEnvelope(api_key, operator, 'claim_operator');
  check(
    'envelope carries operator account_id',
    claimEnvelope.account_id === operator,
    `got ${claimEnvelope.account_id}`,
  );
  const post = await postClaim(apiBase, target, claimEnvelope);
  check('POST status 200', post.status === 200, `got ${post.status}\n    body: ${post.text}`);
  const postBody = post.json();
  check(
    'POST success: true',
    postBody?.success === true,
    `body: ${post.text}`,
  );
  check(
    'POST action: claimed',
    postBody?.data?.action === 'claimed',
    `got action=${postBody?.data?.action}`,
  );
  check(
    'POST echoes verified operator from envelope',
    postBody?.data?.operator_account_id === operator,
    `got ${postBody?.data?.operator_account_id}`,
  );
  check(
    'POST echoes target agent',
    postBody?.data?.agent_account_id === target,
    `got ${postBody?.data?.agent_account_id}`,
  );

  // 3. Read-back — claim must appear in the by-agent list.
  console.log('\n3. GET /agents/{target}/claims (post-write)');
  const after = await getClaims(apiBase, target);
  check('claims read status 200', after.status === 200, `got ${after.status}`);
  const afterBody = after.json();
  check(
    'operator surfaces in operators[]',
    operatorPresent(afterBody, operator),
    `operators: ${JSON.stringify(afterBody?.data?.operators?.map((o) => o.account_id) ?? [])}`,
  );
  // Find the specific entry and sanity-check the envelope round-trip.
  const entry = afterBody?.data?.operators?.find(
    (o) => o.account_id === operator,
  );
  check(
    'entry carries signature + public_key + message for re-verification',
    typeof entry?.signature === 'string' &&
      typeof entry?.public_key === 'string' &&
      typeof entry?.message === 'string',
  );
  check(
    'entry.message round-trips the signed inner JSON',
    entry?.message === claimEnvelope.message,
    `got ${entry?.message}`,
  );
  check(
    'entry carries block-authoritative at_height',
    typeof entry?.at_height === 'number' && entry.at_height > 0,
    `at_height=${entry?.at_height}`,
  );

  // 4. Retract with a fresh envelope (the claim nonce has been replay-burned
  //    by the POST, so we cannot reuse the same envelope).
  console.log('\n4. DELETE /agents/{target}/claim');
  const unclaimEnvelope = await mintEnvelope(api_key, operator, 'unclaim_operator');
  const del = await deleteClaim(apiBase, target, unclaimEnvelope);
  check('DELETE status 200', del.status === 200, `got ${del.status}\n    body: ${del.text}`);
  const delBody = del.json();
  check('DELETE success: true', delBody?.success === true);
  check(
    'DELETE action: unclaimed',
    delBody?.data?.action === 'unclaimed',
    `got action=${delBody?.data?.action}`,
  );

  // 5. Read-back — claim must be gone from the by-agent list.
  console.log('\n5. GET /agents/{target}/claims (post-retract)');
  const afterDelete = await getClaims(apiBase, target);
  check(
    'claims read status 200',
    afterDelete.status === 200,
    `got ${afterDelete.status}`,
  );
  const afterDeleteBody = afterDelete.json();
  check(
    'operator absent from operators[]',
    !operatorPresent(afterDeleteBody, operator),
    `operators still: ${JSON.stringify(afterDeleteBody?.data?.operators?.map((o) => o.account_id) ?? [])}`,
  );

  const total = passed + failed;
  const failedStr = failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed';
  console.log(`\n${total} checks — ${GREEN}${passed} passed${RESET}, ${failedStr}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`${RED}Error: ${err.message}${RESET}`);
  process.exit(1);
});
