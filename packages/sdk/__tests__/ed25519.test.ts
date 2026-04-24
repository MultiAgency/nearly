import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  encodeEd25519PublicKey,
  encodeSignatureBase58,
  parseEd25519SecretKey,
  signRegisterMessage,
} from '../src/ed25519';

function freshKeypair(): {
  seed: Uint8Array;
  secretKey64: Uint8Array;
  publicKey: Uint8Array;
} {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 11) & 0xff;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { seed, secretKey64: kp.secretKey, publicKey: kp.publicKey };
}

describe('parseEd25519SecretKey', () => {
  it('parses a 32-byte seed format and derives the public key', () => {
    const { seed, secretKey64, publicKey } = freshKeypair();
    const str = `ed25519:${bs58.encode(seed)}`;
    const parsed = parseEd25519SecretKey(str);
    expect(parsed.secretKey).toEqual(secretKey64);
    expect(parsed.publicKey).toEqual(publicKey);
  });

  it('parses a 64-byte NEAR concat format and validates the stored pubkey', () => {
    const { seed, secretKey64, publicKey } = freshKeypair();
    const concat = new Uint8Array(64);
    concat.set(seed, 0);
    concat.set(publicKey, 32);
    const str = `ed25519:${bs58.encode(concat)}`;
    const parsed = parseEd25519SecretKey(str);
    expect(parsed.secretKey).toEqual(secretKey64);
    expect(parsed.publicKey).toEqual(publicKey);
  });

  it('rejects a 64-byte key whose stored pubkey does not match the derived one', () => {
    const { seed } = freshKeypair();
    const wrongPubkey = new Uint8Array(32).fill(0xaa);
    const concat = new Uint8Array(64);
    concat.set(seed, 0);
    concat.set(wrongPubkey, 32);
    const str = `ed25519:${bs58.encode(concat)}`;
    expect(() => parseEd25519SecretKey(str)).toThrow(
      /stored public key does not match/,
    );
  });

  it('rejects missing prefix', () => {
    const { seed } = freshKeypair();
    expect(() => parseEd25519SecretKey(bs58.encode(seed))).toThrow(
      /ed25519: prefix/,
    );
  });

  it('rejects non-string input', () => {
    expect(() => parseEd25519SecretKey(undefined as unknown as string)).toThrow(
      /ed25519:<base58> string/,
    );
    expect(() => parseEd25519SecretKey('')).toThrow(/ed25519:<base58> string/);
  });

  it('rejects empty body after prefix', () => {
    expect(() => parseEd25519SecretKey('ed25519:')).toThrow(/empty key body/);
  });

  it('rejects invalid base58', () => {
    expect(() => parseEd25519SecretKey('ed25519:!!!not-b58!!!')).toThrow(
      /invalid base58/,
    );
  });

  it('rejects wrong decoded length', () => {
    const tenBytes = new Uint8Array(10).fill(1);
    expect(() =>
      parseEd25519SecretKey(`ed25519:${bs58.encode(tenBytes)}`),
    ).toThrow(/expected 32 or 64 byte key, got 10/);
  });

  it('throws a typed NearlyError with code VALIDATION_ERROR', () => {
    try {
      parseEd25519SecretKey('not-an-ed25519-key');
      fail('should have thrown');
    } catch (e) {
      expect((e as { shape?: { code?: string } }).shape?.code).toBe(
        'VALIDATION_ERROR',
      );
    }
  });

  it('does not echo raw key bytes into the error message', () => {
    // Well-formed key with the last byte of the stored pub flipped so the
    // validator fires. Assert the raw base58 body never appears in the
    // error message.
    const { seed, publicKey } = freshKeypair();
    const concat = new Uint8Array(64);
    concat.set(seed, 0);
    concat.set(publicKey, 32);
    concat[63] ^= 0x01;
    const body = bs58.encode(concat);
    try {
      parseEd25519SecretKey(`ed25519:${body}`);
      fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(body);
    }
  });
});

describe('signRegisterMessage', () => {
  it('produces a 64-byte signature that verifies under the derived pubkey', () => {
    const { secretKey64, publicKey } = freshKeypair();
    const sig = signRegisterMessage(
      'register:test-seed:1712000000',
      secretKey64,
    );
    expect(sig).toHaveLength(64);
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode('register:test-seed:1712000000'),
      sig,
      publicKey,
    );
    expect(ok).toBe(true);
  });

  it('produces a different signature for a different message (smoke)', () => {
    const { secretKey64 } = freshKeypair();
    const a = signRegisterMessage('register:a:1', secretKey64);
    const b = signRegisterMessage('register:b:1', secretKey64);
    expect(a).not.toEqual(b);
  });
});

describe('encodeEd25519PublicKey', () => {
  it('round-trips via parseEd25519SecretKey (64-byte form)', () => {
    const { seed, publicKey } = freshKeypair();
    const encoded = encodeEd25519PublicKey(publicKey);
    expect(encoded).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);

    const concat = new Uint8Array(64);
    concat.set(seed, 0);
    concat.set(publicKey, 32);
    const keyStr = `ed25519:${bs58.encode(concat)}`;
    const parsed = parseEd25519SecretKey(keyStr);
    expect(encodeEd25519PublicKey(parsed.publicKey)).toBe(encoded);
  });
});

describe('encodeSignatureBase58', () => {
  it('returns base58 with no ed25519: prefix', () => {
    const { secretKey64 } = freshKeypair();
    const sig = signRegisterMessage('register:x:0', secretKey64);
    const encoded = encodeSignatureBase58(sig);
    expect(encoded).not.toMatch(/^ed25519:/);
    expect(encoded).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(bs58.decode(encoded)).toEqual(sig);
  });
});
