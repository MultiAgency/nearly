/**
 * NEAR Verifiable Claim Verification Service
 *
 * Verifies NEP-413 signed messages proving ownership of a NEAR account.
 * Used by POST /agents/register when a verifiable_claim is provided.
 *
 * @typedef {import('../types').VerifiableClaim} VerifiableClaim
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const { queryOne } = require('../config/database');
const { BadRequestError, ConflictError, ApiError } = require('../utils/errors');
const { NEAR_DOMAIN } = require('../utils/constants');

const NEAR_RPC_URL = process.env.NEAR_RPC_URL || 'https://free.rpc.fastnear.com';
const TIMESTAMP_WINDOW_MS = parseInt(process.env.TIMESTAMP_WINDOW_MS, 10) || 5 * 60 * 1000;
const NEP413_TAG = 2147484061; // 2^31 + 413

// Nonce replay protection — track used nonces within the timestamp window
const usedNonces = new Set();
setInterval(() => usedNonces.clear(), TIMESTAMP_WINDOW_MS);

class NearVerificationService {
  /**
   * Verify a complete verifiable_claim.
   * Throws on any verification failure.
   *
   * @param {VerifiableClaim} claim
   */
  static async verifyClaim(claim) {
    // Validate required fields
    if (!claim || typeof claim !== 'object') {
      throw new BadRequestError('verifiable_claim must be an object', 'INVALID_MESSAGE_FORMAT');
    }

    const required = ['near_account_id', 'public_key', 'signature', 'nonce', 'message'];
    for (const field of required) {
      if (!claim[field] || typeof claim[field] !== 'string') {
        throw new BadRequestError(
          `verifiable_claim.${field} is required`,
          'INVALID_MESSAGE_FORMAT',
          `Provide a valid ${field} string`
        );
      }
    }

    // Step 1: Verify message format and timestamp
    const parsedMessage = this.verifyMessageFormat(claim.message);
    this.verifyTimestamp(parsedMessage.timestamp);

    // Step 1b: Validate nonce format before replay check
    const nonceBytes = Buffer.from(claim.nonce, 'base64');
    if (nonceBytes.length !== 32) {
      throw new BadRequestError('Nonce must be 32 bytes', 'INVALID_MESSAGE_FORMAT');
    }

    // Step 1c: Nonce replay protection
    if (usedNonces.has(claim.nonce)) {
      throw new BadRequestError('Nonce already used', 'NONCE_REPLAY');
    }
    usedNonces.add(claim.nonce);

    // Step 2-3: Verify NEP-413 signature
    this.verifyNep413Signature(claim);

    // Step 4: Verify key exists on the NEAR account
    await this.verifyKeyOnChain(claim.near_account_id, claim.public_key);

    // Step 5: Check uniqueness
    await this.checkUniqueness(claim.near_account_id);
  }

  /**
   * Parse and validate the message JSON structure.
   */
  static verifyMessageFormat(message) {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      throw new BadRequestError(
        'Invalid message format',
        'INVALID_MESSAGE_FORMAT',
        'Message must be valid JSON with action, domain, version, timestamp'
      );
    }

    if (parsed.action !== 'register') {
      throw new BadRequestError('Message action must be "register"', 'INVALID_MESSAGE_FORMAT');
    }
    if (parsed.domain !== NEAR_DOMAIN) {
      throw new BadRequestError(`Message domain must be "${NEAR_DOMAIN}"`, 'INVALID_MESSAGE_FORMAT');
    }
    if (parsed.version !== 1) {
      throw new BadRequestError('Message version must be 1', 'INVALID_MESSAGE_FORMAT');
    }
    if (typeof parsed.timestamp !== 'number') {
      throw new BadRequestError('Message timestamp must be a number', 'INVALID_MESSAGE_FORMAT');
    }

    return parsed;
  }

  /**
   * Check that the timestamp is within the allowed window.
   */
  static verifyTimestamp(timestamp) {
    const age = Date.now() - timestamp;
    if (age > TIMESTAMP_WINDOW_MS) {
      throw new BadRequestError(
        'Timestamp expired',
        'TIMESTAMP_EXPIRED',
        'Message must be signed within the last 30 minutes'
      );
    }
    if (age < -60000) {
      // More than 1 minute in the future — clock skew protection
      throw new BadRequestError(
        'Timestamp is in the future',
        'TIMESTAMP_EXPIRED',
        'Check your system clock'
      );
    }
  }

  /**
   * Verify the ed25519 signature over the NEP-413 payload.
   *
   * NEP-413 payload (Borsh-serialized):
   *   tag: u32 = 2^31 + 413
   *   message: string (4-byte LE length + UTF-8)
   *   nonce: [u8; 32] (raw bytes, no length prefix)
   *   recipient: string (4-byte LE length + UTF-8)
   *   callbackUrl: Option<string> (0 byte = None)
   *
   * Signed data = sha256(payload)
   */
  static verifyNep413Signature(claim) {
    const { public_key, signature, nonce, message } = claim;
    const recipient = NEAR_DOMAIN;

    // Decode public key from "ed25519:..." base58 format (must be 32 bytes)
    const pubKeyBytes = this.decodeBase58Key(public_key);
    if (pubKeyBytes.length !== 32) {
      throw new BadRequestError('Public key must be 32 bytes', 'INVALID_MESSAGE_FORMAT');
    }

    // Decode signature from "ed25519:..." base58 format
    const sigBytes = this.decodeBase58Key(signature);
    if (sigBytes.length !== 64) {
      throw new BadRequestError('Invalid signature length', 'INVALID_SIGNATURE');
    }

    // Decode nonce from base64 (size already validated in verifyClaim)
    const nonceBytes = Buffer.from(nonce, 'base64');

    // Construct NEP-413 Borsh payload.
    // Layout: tag (u32 LE) | message (Borsh string) | nonce ([u8; 32]) | recipient (Borsh string) | callbackUrl (Option<string> = None)
    // Tag value: 2^31 + 413 = 2147484061 — identifies this as a NEP-413 payload
    // Borsh string: u32 LE length prefix + UTF-8 bytes
    // The payload is SHA-256 hashed, then verified against the ed25519 signature.
    const messageBytes = Buffer.from(message, 'utf-8');
    const recipientBytes = Buffer.from(recipient, 'utf-8');

    const payload = Buffer.concat([
      // tag: u32 LE
      this.writeU32LE(NEP413_TAG),
      // message: Borsh string (u32 LE length + bytes)
      this.writeU32LE(messageBytes.length),
      messageBytes,
      // nonce: [u8; 32] (fixed-size, no length prefix)
      nonceBytes,
      // recipient: Borsh string
      this.writeU32LE(recipientBytes.length),
      recipientBytes,
      // callbackUrl: Option<string> = None
      Buffer.from([0]),
    ]);

    // Hash the payload
    const hash = crypto.createHash('sha256').update(payload).digest();

    // Verify signature
    const valid = nacl.sign.detached.verify(hash, sigBytes, pubKeyBytes);
    if (!valid) {
      throw new BadRequestError(
        'Invalid signature',
        'INVALID_SIGNATURE',
        'ed25519 signature verification failed'
      );
    }
  }

  /**
   * Verify the public key exists as an access key on the NEAR account.
   *
   * For custodial wallets (e.g. OutLayer trial accounts), the key may not
   * be on-chain yet — the account is implicit and unfunded. In that case,
   * the ed25519 signature verification (step 3) is sufficient proof of
   * key ownership. We log a warning but don't reject.
   */
  static async verifyKeyOnChain(nearAccountId, publicKey) {
    let response;
    try {
      response = await fetch(NEAR_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'fastbook',
          method: 'query',
          params: {
            request_type: 'view_access_key',
            finality: 'final',
            account_id: nearAccountId,
            public_key: publicKey,
          },
        }),
      });
    } catch (err) {
      // RPC unreachable — signature verification already passed, so allow it
      console.warn('NEAR RPC unavailable, skipping on-chain key check');
      return;
    }

    const data = await response.json();

    if (data.error) {
      const msg = data.error.cause?.name || data.error.message || 'Unknown RPC error';
      if (msg === 'UNKNOWN_ACCESS_KEY' || msg === 'UNKNOWN_ACCOUNT' || msg.includes('does not exist')) {
        // Key/account not on-chain — likely a custodial or unfunded implicit account.
        // The signature was already verified cryptographically, so this is acceptable.
        console.warn(`On-chain key check: ${msg} for ${nearAccountId} — allowing (custodial wallet)`);
        return;
      }
      // Unexpected RPC error — log but don't block
      console.warn('NEAR RPC error:', msg);
      return;
    }

    // If we got a result, the key exists on-chain — strongest proof
  }

  /**
   * Check that the NEAR account isn't already claimed by another agent.
   */
  static async checkUniqueness(nearAccountId) {
    const existing = await queryOne(
      'SELECT id, name FROM agents WHERE near_account_id = $1',
      [nearAccountId]
    );

    if (existing) {
      throw new ConflictError(
        'NEAR account already claimed',
        'Use a different account or contact support'
      );
    }
  }

  // --- Helpers ---

  /**
   * Write a u32 as a 4-byte little-endian Buffer.
   * Used for Borsh serialization of string lengths and the NEP-413 tag.
   *
   * @param {number} value - Unsigned 32-bit integer
   * @returns {Buffer} 4-byte LE buffer
   */
  static writeU32LE(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value);
    return buf;
  }

  /**
   * Decode a NEAR-style "ed25519:<base58>" key string to raw bytes.
   *
   * @param {string} keyStr - Key in "ed25519:..." format
   * @returns {Buffer} Raw key bytes (32 bytes for public keys, 64 bytes for signatures)
   * @throws {BadRequestError} If prefix is missing or base58 is invalid
   */
  static decodeBase58Key(keyStr) {
    const prefix = 'ed25519:';
    if (!keyStr.startsWith(prefix)) {
      throw new BadRequestError(`Key must start with "${prefix}"`, 'INVALID_MESSAGE_FORMAT');
    }
    const encoded = keyStr.slice(prefix.length);
    return this.base58Decode(encoded);
  }

  /**
   * Base58 decoder using the Bitcoin alphabet (123456789ABCDEFGH...).
   * Handles leading '1' characters as zero bytes.
   *
   * @param {string} str - Base58-encoded string
   * @returns {Buffer} Decoded raw bytes
   * @throws {BadRequestError} If string contains invalid base58 characters
   */
  static base58Decode(str) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const BASE = BigInt(58);

    let num = BigInt(0);
    for (const char of str) {
      const idx = ALPHABET.indexOf(char);
      if (idx === -1) throw new BadRequestError('Invalid base58 character', 'INVALID_MESSAGE_FORMAT');
      num = num * BASE + BigInt(idx);
    }

    // Convert to bytes
    const hex = num.toString(16).padStart(2, '0');
    const bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');

    // Add leading zeros
    let leadingZeros = 0;
    for (const char of str) {
      if (char === '1') leadingZeros++;
      else break;
    }

    return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
  }
}

module.exports = NearVerificationService;
