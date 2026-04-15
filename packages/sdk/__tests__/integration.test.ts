/**
 * Integration test: real FastData + OutLayer round-trip.
 *
 * Gated on both WK_KEY and WK_ACCOUNT_ID. Skipped in CI and normal local
 * runs. Run manually before release:
 *
 *   WK_KEY=wk_... WK_ACCOUNT_ID=alice.near npx jest integration
 *
 * This is the only layer that catches protocol drift — FastData or OutLayer
 * renaming a response field, changing a status code, or shifting behavior.
 * Unit tests with mocked fetch cannot see that.
 */

import { NearlyClient } from '../src/client';
import { DEFAULT_FASTDATA_URL, DEFAULT_NAMESPACE } from '../src/constants';
import { createReadTransport, kvGetKey } from '../src/read';

const hasCreds = !!process.env.WK_KEY && !!process.env.WK_ACCOUNT_ID;
const suite = hasCreds ? describe : describe.skip;

// Register integration is separately gated — every run burns a real
// OutLayer trial wallet, so we don't want it to tag along with WK_KEY-gated
// heartbeat runs. Opt in explicitly:
//
//   NEARLY_REGISTER_INTEGRATION=1 npx jest integration
//
// Do NOT set this in CI. Each run provisions a new trial wallet and leaves
// a residue account on FastData main that cannot be cleanly reclaimed
// (the key is ephemeral, and the account has no profile to delist).
const hasRegisterGate = process.env.NEARLY_REGISTER_INTEGRATION === '1';
const registerSuite = hasRegisterGate ? describe : describe.skip;

registerSuite('integration: real OutLayer register', () => {
  it('provisions a trial wallet with a usable wk_ and 64-hex account', async () => {
    const { client, accountId, walletKey, trial } =
      await NearlyClient.register();
    expect(walletKey).toMatch(/^wk_/);
    // OutLayer implicit accounts are 64 lowercase hex characters.
    expect(accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(client.accountId).toBe(accountId);
    expect(typeof trial.calls_remaining).toBe('number');
    expect(trial.calls_remaining).toBeGreaterThanOrEqual(0);
    // Intentionally do NOT heartbeat — this test provisions a wallet but
    // does not exercise it. Each run consumes one OutLayer trial slot and
    // we want a single round-trip per run.
  }, 15_000);
});

// Separate gate from WK_KEY so running the heartbeat integration test
// doesn't inadvertently derive sub-wallets on every run. Each sub-agent
// derivation creates a residue sub-wallet that cannot be cleanly
// reclaimed — DELETE /wallet/v1/api-key/{key_hash} rejects "last active
// key for the wallet", so the derived wk_ stays live indefinitely.
// Accept the residue (same posture as the register gate).
//
//   NEARLY_SUB_AGENT_INTEGRATION=1 WK_KEY=wk_... WK_ACCOUNT_ID=alice.near \
//     npx jest integration
//
// Do NOT set this in CI.
const hasSubAgentGate = process.env.NEARLY_SUB_AGENT_INTEGRATION === '1';
const subAgentSuite = hasSubAgentGate ? describe : describe.skip;

subAgentSuite('integration: real OutLayer sub-agent derivation', () => {
  it('derives a sub-wallet from an existing parent', async () => {
    const parent = new NearlyClient({
      walletKey: process.env.WK_KEY!,
      accountId: process.env.WK_ACCOUNT_ID!,
    });
    // Time-based seed so each run creates a distinct sub-wallet — avoids
    // re-deriving the same wallet across runs on the same parent account.
    const seed = `subagent-test-${Date.now()}`;
    const result = await parent.deriveSubAgent({ seed });
    expect(result.walletKey).toMatch(/^wk_[0-9a-f]{64}$/);
    expect(result.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.client.accountId).toBe(result.accountId);
    // Same seed a second time MUST produce the same derived wallet —
    // proves OutLayer's server-side idempotency and the SDK's pure
    // derivation agree in the live wire contract.
    const result2 = await parent.deriveSubAgent({ seed });
    expect(result2.walletKey).toBe(result.walletKey);
    expect(result2.accountId).toBe(result.accountId);
    // Intentionally do NOT exercise the sub-wallet beyond this —
    // residue budget is real and each run provisions a fresh wallet.
  }, 15_000);
});

suite('integration: real FastData + OutLayer', () => {
  it('heartbeat round-trips and advances last_active', async () => {
    const walletKey = process.env.WK_KEY!;
    const accountId = process.env.WK_ACCOUNT_ID!;

    const readTransport = createReadTransport({
      fastdataUrl: DEFAULT_FASTDATA_URL,
      namespace: DEFAULT_NAMESPACE,
    });

    const beforeEntry = await kvGetKey(readTransport, accountId, 'profile');
    // `before` is the block_timestamp of the prior profile write, in
    // nanoseconds. 0 if no prior profile exists.
    const before = beforeEntry?.block_timestamp ?? 0;

    const client = new NearlyClient({ walletKey, accountId });
    await client.heartbeat();

    // FastData indexes NEAR transactions asynchronously — the write lands
    // on-chain synchronously (OutLayer 200), but the KV read surface lags
    // by a few seconds. Poll until we see the profile entry's block_timestamp
    // advance past the pre-write value, or time out. Block_timestamp is the
    // only authoritative "when did this happen" — `last_active` is no longer
    // a stored field, it's read-derived from `entry.block_timestamp`.
    const deadline = Date.now() + 15_000;
    let after = before;
    while (Date.now() < deadline) {
      const afterEntry = await kvGetKey(readTransport, accountId, 'profile');
      if (afterEntry && afterEntry.block_timestamp > before) {
        after = afterEntry.block_timestamp;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(after).toBeGreaterThan(before);
  }, 30_000);
});
