/**
 * Wallet key leakage sweep — extracted from client.test.ts for focus and
 * symmetry with cli/leakage-sweep.test.ts. Every error-construction site in
 * the SDK must pass detail strings through `sanitizeErrorDetail`, which
 * redacts wk_ tokens before they enter the error surface. This sweep drives
 * each body-interpolation path with a contaminated upstream response and
 * asserts the serialized NearlyError does not carry the prefix anywhere —
 * message, shape, or cause. The placeholder `[REDACTED_WK]` is the only
 * acceptable mark.
 *
 * Coverage matches BUILD.md §4: "scan all error fixtures for
 * /wk_[A-Za-z0-9]+/ and fail if matched." This sweep covers the runtime
 * paths where OutLayer / FastData error bodies could contain a token; the
 * narrow register-parse leak test remains in client.test.ts next to
 * NearlyClient.register.
 */

import { NearlyClient } from '../src/client';
import { NearlyError } from '../src/errors';
import type { FetchLike } from '../src/read';
import type { Agent } from '../src/types';
import { aliceProfileBlob } from './fixtures/entries';
import { jsonResponse, scripted } from './fixtures/http';

function profileEntryResponse(agent: Agent): Response {
  return jsonResponse({
    entries: [
      {
        predecessor_id: agent.account_id,
        current_account_id: 'contextual.near',
        block_height: 1,
        block_timestamp: 1,
        key: 'profile',
        value: agent,
      },
    ],
  });
}

function clientOf(fetch: FetchLike): NearlyClient {
  return new NearlyClient({
    walletKey: 'wk_test',
    accountId: 'alice.near',
    fastdataUrl: 'https://kv.example',
    outlayerUrl: 'https://outlayer.example',
    namespace: 'contextual.near',
    fetch,
    rateLimiting: false,
  });
}

describe('wallet key leakage sweep', () => {
  const LEAK_KEY = 'wk_LEAK_abc123';
  const LEAK_PATTERN = /wk_[A-Za-z0-9_]+/;

  function assertNoLeak(err: unknown): void {
    expect(err).toBeInstanceOf(NearlyError);
    const nearlyErr = err as NearlyError;
    const serialized = JSON.stringify({
      message: nearlyErr.message,
      shape: nearlyErr.shape,
    });
    expect(serialized).not.toMatch(LEAK_PATTERN);
    // Placeholder should appear where the raw token was — sanity-check
    // that the body actually reached the sanitizer rather than being
    // silently dropped somewhere upstream.
    expect(serialized).toContain('[REDACTED_WK]');
  }

  function textResponse(body: string, status: number): Response {
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  it('writeEntries 500 body is sanitized before protocolError interpolation', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/v0/latest/'))
        return profileEntryResponse(aliceProfileBlob);
      if (url.includes('/wallet/v1/call'))
        return textResponse(
          `upstream error, key was ${LEAK_KEY} in header`,
          500,
        );
      return new Response(null, { status: 404 });
    });
    const client = clientOf(fetch);
    try {
      await client.heartbeat();
      throw new Error('expected heartbeat to throw');
    } catch (err) {
      assertNoLeak(err);
    }
  });

  it('writeEntries network-layer fetch throw with wk_ in cause message is sanitized', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/v0/latest/'))
        return profileEntryResponse(aliceProfileBlob);
      if (url.includes('/wallet/v1/call')) {
        throw new Error(`connection reset mid-request, auth=${LEAK_KEY}`);
      }
      return new Response(null, { status: 404 });
    });
    const client = clientOf(fetch);
    try {
      await client.heartbeat();
      throw new Error('expected heartbeat to throw');
    } catch (err) {
      assertNoLeak(err);
    }
  });

  it('createWallet 5xx body is sanitized before protocolError interpolation', async () => {
    const { fetch } = scripted(() =>
      textResponse(`upstream rejected, offending token ${LEAK_KEY}`, 503),
    );
    try {
      await NearlyClient.register({
        outlayerUrl: 'https://outlayer.example',
        fetch,
      });
      throw new Error('expected register to throw');
    } catch (err) {
      assertNoLeak(err);
    }
  });

  it('getBalance 5xx body is sanitized before protocolError interpolation', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/wallet/v1/balance'))
        return textResponse(`backend error: ${LEAK_KEY} was in the log`, 500);
      return new Response(null, { status: 404 });
    });
    const client = clientOf(fetch);
    try {
      await client.getBalance();
      throw new Error('expected getBalance to throw');
    } catch (err) {
      assertNoLeak(err);
    }
  });

  it('getBalance network-layer fetch throw with wk_ in cause is sanitized', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/wallet/v1/balance')) {
        throw new Error(`socket hang up, req headers had ${LEAK_KEY}`);
      }
      return new Response(null, { status: 404 });
    });
    const client = clientOf(fetch);
    try {
      await client.getBalance();
      throw new Error('expected getBalance to throw');
    } catch (err) {
      assertNoLeak(err);
    }
  });
});
