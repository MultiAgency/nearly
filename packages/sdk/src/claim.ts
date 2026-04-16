import { DEFAULT_TIMEOUT_MS } from './constants';
import { networkError, protocolError } from './errors';
import type { FetchLike } from './read';
import type { VerifiableClaim, VerifyClaimResponse } from './types';
import { signMessage, type WalletClient } from './wallet';

/**
 * Inputs to a NEP-413 structured claim. `domain` and `version` are
 * optional: when omitted, `signClaim` falls back to the corresponding
 * fields on the `WalletClient`. Primitive callers that want to sign
 * into a different domain pass them explicitly to override.
 */
export interface ClaimInput {
  action: string;
  accountId: string;
  domain?: string;
  version?: number;
}

/**
 * Build the canonical NEP-413 structured claim message. Pure — no I/O,
 * no state beyond `Date.now()`. The JSON shape and key order are
 * load-bearing: any verifier that validates the exact string (e.g. the
 * Nearly WASM) will reject drift, so this builder is the single source
 * of truth for the envelope layout. All four fields are required.
 */
export function buildClaim(input: {
  action: string;
  accountId: string;
  domain: string;
  version: number;
}): string {
  return JSON.stringify({
    action: input.action,
    domain: input.domain,
    account_id: input.accountId,
    version: input.version,
    timestamp: Date.now(),
  });
}

/**
 * Sign a structured NEP-413 claim via OutLayer's sign-message endpoint.
 * `domain` and `version` default to `client.claimDomain` /
 * `client.claimVersion`; callers override per-call by passing them on
 * the input. `recipient` on the sign-message wire is pinned to the
 * resolved `domain` — the standard NEP-413 binding between what was
 * signed and who it was signed for.
 */
export async function signClaim(
  client: WalletClient,
  input: ClaimInput,
): Promise<VerifiableClaim> {
  const domain = input.domain ?? client.claimDomain;
  const version = input.version ?? client.claimVersion;
  return signMessage(client, {
    message: buildClaim({
      action: input.action,
      accountId: input.accountId,
      domain,
      version,
    }),
    recipient: domain,
  });
}

/**
 * Verify a signed NEP-413 claim envelope against a verifier endpoint.
 * `url` is the full verifier URL — no `baseUrl` default, no implicit
 * path: the primitive layer does not know which verifier a caller is
 * talking to, so the caller passes the URL explicitly. `recipient`
 * pins what the verifier should check the signature was bound to; the
 * optional `expectedDomain` tightens the message-layer check.
 *
 * The response shape is a structured `{ valid, ... }` envelope — verifier
 * returns 200 on both success and structured failure (`valid: false`).
 * Only RPC-layer problems surface as non-2xx (except 502, which the
 * Nearly verifier uses for upstream RPC issues and which is still parsed
 * as a structured failure).
 */
export async function verifyClaim(
  claim: {
    account_id: string;
    public_key: string;
    signature: string;
    nonce: string;
    message: string;
  },
  opts: {
    url: string;
    recipient: string;
    expectedDomain?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
  },
): Promise<VerifyClaimResponse> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...claim,
        recipient: opts.recipient,
        ...(opts.expectedDomain !== undefined && {
          expected_domain: opts.expectedDomain,
        }),
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok && res.status !== 502) {
    const detail = await res.text().catch(() => '');
    throw protocolError(
      `verifyClaim ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('verifyClaim: malformed JSON in response');
  }
  if (!body || typeof body !== 'object' || !('valid' in body)) {
    throw protocolError('verifyClaim: response missing `valid` field');
  }
  return body as VerifyClaimResponse;
}
