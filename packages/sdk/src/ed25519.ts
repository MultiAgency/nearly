import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { validationError } from './errors';

export interface ParsedEd25519Key {
  /**
   * The 64-byte tweetnacl "secret key" — seed concatenated with the
   * derived public key. Pass directly to `signRegisterMessage`; do not
   * log or persist.
   */
  secretKey: Uint8Array;
  /**
   * The 32-byte derived public key, suitable for `encodeEd25519PublicKey`.
   */
  publicKey: Uint8Array;
}

const ED25519_PREFIX = 'ed25519:';

/**
 * Parse a NEAR-formatted ed25519 secret key string into raw bytes.
 *
 * Accepts two on-disk shapes, both NEAR-common:
 *   `ed25519:<base58-32-bytes>` — raw seed only.
 *   `ed25519:<base58-64-bytes>` — concat of `seed || publicKey`, NEAR's
 *     default storage format for a full keypair.
 *
 * In the 64-byte case the stored public key is validated against the one
 * derived from the seed; a mismatch throws rather than silently trusting
 * the stored half, which would let a corrupted key produce valid-looking
 * registrations that OutLayer would then reject.
 *
 * Errors surface as typed `NearlyError(VALIDATION_ERROR)` with `field:
 * 'privateKey'` and a `reason` that never echoes the raw key bytes.
 */
export function parseEd25519SecretKey(str: string): ParsedEd25519Key {
  if (typeof str !== 'string' || !str) {
    throw validationError('privateKey', 'expected ed25519:<base58> string');
  }
  if (!str.startsWith(ED25519_PREFIX)) {
    throw validationError('privateKey', 'expected ed25519: prefix');
  }
  const body = str.slice(ED25519_PREFIX.length);
  if (!body) {
    throw validationError('privateKey', 'empty key body after ed25519: prefix');
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(body);
  } catch {
    throw validationError('privateKey', 'invalid base58 encoding');
  }

  // tweetnacl's "secret key" is the 64-byte concat of seed + public. We
  // accept either shape on input and normalize to the 64-byte form that
  // `nacl.sign.detached` takes.
  if (decoded.length === 32) {
    const kp = nacl.sign.keyPair.fromSeed(decoded);
    return { secretKey: kp.secretKey, publicKey: kp.publicKey };
  }
  if (decoded.length === 64) {
    const seed = decoded.slice(0, 32);
    const storedPublic = decoded.slice(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    if (!constantTimeEquals(kp.publicKey, storedPublic)) {
      throw validationError(
        'privateKey',
        'stored public key does not match derived public key',
      );
    }
    return { secretKey: kp.secretKey, publicKey: kp.publicKey };
  }
  throw validationError(
    'privateKey',
    `expected 32 or 64 byte key, got ${decoded.length}`,
  );
}

/**
 * Raw ed25519 sign over `message`'s UTF-8 bytes. Returns a 64-byte
 * signature. This is NOT NEP-413 — the OutLayer deterministic-register
 * endpoint wants the raw signature, per agent-custody SKILL.md
 * §"Signature format (IMPORTANT)".
 *
 * `secretKey` must be tweetnacl's 64-byte form (seed || publicKey), as
 * returned by `parseEd25519SecretKey`.
 */
export function signRegisterMessage(
  message: string,
  secretKey: Uint8Array,
): Uint8Array {
  return nacl.sign.detached(new TextEncoder().encode(message), secretKey);
}

/**
 * Encode a 32-byte ed25519 public key as `ed25519:<base58>`. Inverse of
 * the public-key half of `parseEd25519SecretKey`.
 */
export function encodeEd25519PublicKey(publicKey: Uint8Array): string {
  return `${ED25519_PREFIX}${bs58.encode(publicKey)}`;
}

/**
 * Encode a 64-byte signature as plain base58 with no prefix — the wire
 * format OutLayer's deterministic `/register` expects.
 */
export function encodeSignatureBase58(signature: Uint8Array): string {
  return bs58.encode(signature);
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
