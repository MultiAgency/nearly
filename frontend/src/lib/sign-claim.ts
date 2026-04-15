import type { VerifiableClaim } from '@/types';

/**
 * Canonical NEP-413 claim construction for the Lightweight sign-in feature.
 *
 * The server-side verifier lives in `frontend/src/lib/verify-claim.ts` and
 * accepts any NEP-413 envelope whose inner `message` is a JSON object with
 * `{action, domain, account_id, version, timestamp}` — matching exactly
 * what `buildClaimMessage` in `outlayer-server.ts` produces on the agent
 * side. That symmetry is important: a claim signed by a human's browser
 * via NEAR Connect and a claim signed by an OutLayer `wk_` wallet land on
 * the same verification path, because neither the message shape nor the
 * signature format differ between the two.
 *
 * Naming parity: the server-side helper is `signClaimForWalletKey` in
 * `outlayer-server.ts`. The wallet doesn't mint anything — it produces a
 * signature over a canonical message, and the caller packages the result
 * as a `VerifiableClaim`. Client and server use the same vocabulary.
 *
 * This module is deliberately React-free — the `signClaim` function takes
 * its wallet dependency as an injected parameter, so unit tests exercise
 * the composition logic against a mock signer without standing up a
 * NearProvider. The React binding lives in the sign-in page.
 */

const CLAIM_DOMAIN = 'nearly.social';
const CLAIM_VERSION = 1;
const NONCE_BYTES = 32;

/**
 * NEP-413 signer return shape. Structurally matches `SignedMessage` from
 * `@hot-labs/near-connect` but redeclared here so this module has zero
 * runtime dependencies on NEAR Connect — callers thread the function in
 * from `useNearWallet()`'s `signNEP413Message`, and tests mock it.
 */
export type Nep413Signer = (params: {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}) => Promise<{
  accountId: string;
  publicKey: string;
  signature: string;
}>;

export interface SignClaimDeps {
  signNEP413Message: Nep413Signer;
  /**
   * The currently signed-in NEAR account ID, used to compose the inner
   * message's `account_id` field. The server-side verifier rejects claims
   * where the inner message's `account_id` mismatches the outer claim's
   * `account_id`, so this must match whatever the wallet will sign under.
   */
  accountId: string;
  /** Injection point for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injection point for deterministic tests. Defaults to Web Crypto. */
  generateNonce?: () => Uint8Array;
}

/**
 * Compose the canonical inner message string that `signClaim` signs.
 * Exported for unit tests and for any caller that needs to reconstruct
 * the exact bytes a claim was signed over.
 */
export function buildClaimMessage(
  action: string,
  accountId: string,
  timestamp: number,
): string {
  return JSON.stringify({
    action,
    domain: CLAIM_DOMAIN,
    account_id: accountId,
    version: CLAIM_VERSION,
    timestamp,
  });
}

function defaultGenerateNonce(): Uint8Array {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Encode a binary nonce as base64 for the wire. `verify-claim.ts` decodes
 * via `Buffer.from(x, 'base64')`, which tolerates padding variants and
 * base64url characters; we emit canonical base64 with padding for
 * cross-consumer consistency.
 */
function nonceToWire(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Produce a fresh NEP-413 `VerifiableClaim` via the caller's connected
 * NEAR wallet. Pure-ish function: all side effects are constrained to
 * the injected `signNEP413Message` call and (by default) `Date.now` plus
 * Web Crypto's RNG, both overridable for tests.
 *
 * The returned claim's `account_id`, `public_key`, and `signature` come
 * from the wallet's NEP-413 return — those are what the verifier will
 * re-check. The `accountId` input is used only to embed the signer's
 * asserted identity in the inner message, which the verifier
 * cross-checks against the outer `account_id` per
 * `verify-claim.ts::verifyClaim` (the "message account_id does not
 * match claim account_id" guard).
 *
 * Claims are valid for `CLAIM_FRESHNESS_MS` from `timestamp` and each
 * call consumes one nonce slot in the server-side replay store, keyed
 * per `recipient`. Freshness and replay windows are enforced server-side
 * — this function just produces the envelope.
 */
export async function signClaim(
  deps: SignClaimDeps,
  action: string,
  recipient: string,
): Promise<VerifiableClaim> {
  const now = deps.now ?? Date.now;
  const generateNonce = deps.generateNonce ?? defaultGenerateNonce;

  const message = buildClaimMessage(action, deps.accountId, now());
  const nonce = generateNonce();

  const signed = await deps.signNEP413Message({
    message,
    recipient,
    nonce,
  });

  return {
    account_id: signed.accountId,
    public_key: signed.publicKey,
    signature: signed.signature,
    nonce: nonceToWire(nonce),
    message,
  };
}
