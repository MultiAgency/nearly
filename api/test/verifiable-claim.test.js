/**
 * Verifiable Claim Test Suite
 *
 * Tests NEP-413 signature verification for NEAR account ownership.
 * Run: node test/verifiable-claim.test.js
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const NearVerificationService = require('../src/services/NearVerificationService');
const { BadRequestError, ConflictError } = require('../src/utils/errors');

const { describe, test, assert, assertEqual, assertThrows, runTests } = require('./helpers');

// --- Test Helpers ---

/**
 * Create a valid NEP-413 signed claim using a fresh ed25519 keypair.
 */
function createTestClaim(overrides = {}) {
  const keypair = nacl.sign.keyPair();

  const message = overrides.message || JSON.stringify({
    action: 'register',
    domain: 'market.near.ai',
    version: 1,
    timestamp: overrides.timestamp || Date.now(),
  });

  const recipient = 'market.near.ai';
  const nonce = overrides.nonce || crypto.randomBytes(32);
  const nonceBase64 = Buffer.from(nonce).toString('base64');

  // Construct NEP-413 Borsh payload
  const NEP413_TAG = 2147484061;
  const messageBytes = Buffer.from(message, 'utf-8');
  const recipientBytes = Buffer.from(recipient, 'utf-8');

  const payload = Buffer.concat([
    writeU32LE(NEP413_TAG),
    writeU32LE(messageBytes.length),
    messageBytes,
    Buffer.from(nonce),
    writeU32LE(recipientBytes.length),
    recipientBytes,
    Buffer.from([0]), // callbackUrl = None
  ]);

  const hash = crypto.createHash('sha256').update(payload).digest();
  const signature = nacl.sign.detached(hash, keypair.secretKey);

  const publicKeyBase58 = 'ed25519:' + base58Encode(Buffer.from(keypair.publicKey));
  const signatureBase58 = 'ed25519:' + base58Encode(Buffer.from(signature));

  return {
    claim: {
      near_account_id: overrides.near_account_id || 'test-account.near',
      public_key: overrides.public_key || publicKeyBase58,
      signature: overrides.signature || signatureBase58,
      nonce: nonceBase64,
      message,
    },
    keypair,
  };
}

function writeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function base58Encode(buffer) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + buffer.toString('hex'));
  let str = '';
  while (num > 0n) {
    str = ALPHABET[Number(num % 58n)] + str;
    num = num / 58n;
  }
  for (const byte of buffer) {
    if (byte === 0) str = '1' + str;
    else break;
  }
  return str || '1';
}

// --- Tests ---

describe('Message Format Validation', () => {
  test('accepts valid message', () => {
    const message = JSON.stringify({
      action: 'register',
      domain: 'market.near.ai',
      version: 1,
      timestamp: Date.now(),
    });
    const result = NearVerificationService.verifyMessageFormat(message);
    assertEqual(result.action, 'register');
  });

  test('rejects non-JSON message', async () => {
    await assertThrows(
      () => NearVerificationService.verifyMessageFormat('not json'),
      'INVALID_MESSAGE_FORMAT',
      'Non-JSON message'
    );
  });

  test('rejects wrong action', async () => {
    const message = JSON.stringify({
      action: 'login',
      domain: 'market.near.ai',
      version: 1,
      timestamp: Date.now(),
    });
    await assertThrows(
      () => NearVerificationService.verifyMessageFormat(message),
      'INVALID_MESSAGE_FORMAT',
      'Wrong action'
    );
  });

  test('rejects wrong domain', async () => {
    const message = JSON.stringify({
      action: 'register',
      domain: 'other.site',
      version: 1,
      timestamp: Date.now(),
    });
    await assertThrows(
      () => NearVerificationService.verifyMessageFormat(message),
      'INVALID_MESSAGE_FORMAT',
      'Wrong domain'
    );
  });
});

describe('Timestamp Validation', () => {
  test('accepts fresh timestamp', () => {
    // verifyTimestamp throws on invalid — no throw means pass
    NearVerificationService.verifyTimestamp(Date.now());
  });

  test('accepts timestamp 4 minutes ago', () => {
    NearVerificationService.verifyTimestamp(Date.now() - 4 * 60 * 1000);
  });

  test('rejects timestamp 31 minutes ago', async () => {
    await assertThrows(
      () => NearVerificationService.verifyTimestamp(Date.now() - 31 * 60 * 1000),
      'TIMESTAMP_EXPIRED',
      'Expired timestamp'
    );
  });

  test('rejects timestamp far in the future', async () => {
    await assertThrows(
      () => NearVerificationService.verifyTimestamp(Date.now() + 5 * 60 * 1000),
      'TIMESTAMP_EXPIRED',
      'Future timestamp'
    );
  });
});

describe('NEP-413 Signature Verification', () => {
  test('accepts valid signature', () => {
    const { claim } = createTestClaim();
    NearVerificationService.verifyNep413Signature(claim);
    // No throw = pass
  });

  test('rejects tampered message', async () => {
    const { claim } = createTestClaim();
    // Tamper with the message after signing
    claim.message = claim.message.replace('"register"', '"login"');
    await assertThrows(
      () => NearVerificationService.verifyNep413Signature(claim),
      'INVALID_SIGNATURE',
      'Tampered message'
    );
  });

  test('rejects wrong public key', async () => {
    const { claim } = createTestClaim();
    // Replace with a different keypair's public key
    const otherKeypair = nacl.sign.keyPair();
    claim.public_key = 'ed25519:' + base58Encode(Buffer.from(otherKeypair.publicKey));
    await assertThrows(
      () => NearVerificationService.verifyNep413Signature(claim),
      'INVALID_SIGNATURE',
      'Wrong public key'
    );
  });

  test('rejects tampered nonce', async () => {
    const { claim } = createTestClaim();
    claim.nonce = crypto.randomBytes(32).toString('base64');
    await assertThrows(
      () => NearVerificationService.verifyNep413Signature(claim),
      'INVALID_SIGNATURE',
      'Tampered nonce'
    );
  });

  test('rejects invalid base58 key', async () => {
    const { claim } = createTestClaim();
    claim.public_key = 'ed25519:INVALID0OIl';
    await assertThrows(
      () => NearVerificationService.verifyNep413Signature(claim),
      'INVALID_MESSAGE_FORMAT',
      'Invalid base58'
    );
  });
});

describe('Base58 Encoding/Decoding', () => {
  test('round-trips correctly', () => {
    const original = crypto.randomBytes(32);
    const encoded = base58Encode(original);
    const decoded = NearVerificationService.base58Decode(encoded);
    assert(original.equals(decoded), 'Round-trip should preserve bytes');
  });

  test('decodeBase58Key strips ed25519: prefix', () => {
    const keypair = nacl.sign.keyPair();
    const encoded = 'ed25519:' + base58Encode(Buffer.from(keypair.publicKey));
    const decoded = NearVerificationService.decodeBase58Key(encoded);
    assertEqual(decoded.length, 32, 'Public key should be 32 bytes');
    assert(Buffer.from(keypair.publicKey).equals(decoded), 'Should match original');
  });
});

describe('Required Fields Validation', () => {
  test('rejects missing near_account_id', async () => {
    const { claim } = createTestClaim();
    delete claim.near_account_id;
    await assertThrows(
      () => NearVerificationService.verifyClaim(claim),
      'INVALID_MESSAGE_FORMAT',
      'Missing near_account_id'
    );
  });

  test('rejects missing public_key', async () => {
    const { claim } = createTestClaim();
    delete claim.public_key;
    await assertThrows(
      () => NearVerificationService.verifyClaim(claim),
      'INVALID_MESSAGE_FORMAT',
      'Missing public_key'
    );
  });

  test('rejects null claim', async () => {
    await assertThrows(
      () => NearVerificationService.verifyClaim(null),
      'INVALID_MESSAGE_FORMAT',
      'Null claim'
    );
  });
});

// --- Run ---
runTests('Verifiable Claim Test Suite');
