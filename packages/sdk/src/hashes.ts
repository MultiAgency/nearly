/**
 * Cross-runtime HMAC-SHA256 and SHA-256 primitives.
 *
 * **Async.** SubtleCrypto's digest and HMAC APIs are promise-returning;
 * to share a shape with Node's synchronous `crypto` module we harmonize
 * both to async. This diverges from `ed25519.ts`'s sync signing path —
 * ed25519 operations run sync everywhere via tweetnacl, hash operations
 * run async because we prefer native browser crypto (SubtleCrypto, audited
 * by the platform) over bundling another JS hash library.
 *
 * **Runtime detection.** We check for a Node-shaped `process.versions.node`
 * to pick the Node code path. Browser / edge runtimes fall through to
 * `globalThis.crypto.subtle`. Consumers who need one specific runtime can
 * skip this shim and call the underlying primitive directly.
 */

const isNode =
  typeof process !== 'undefined' &&
  process.versions != null &&
  typeof process.versions.node === 'string';

export async function hmacSha256(
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (isNode) {
    // Dynamic import keeps the Node-only module out of browser bundles that
    // tree-shake the `isNode === false` branch at build time.
    const { createHmac } = await import('node:crypto');
    const h = createHmac('sha256', Buffer.from(key));
    h.update(Buffer.from(message));
    return new Uint8Array(h.digest());
  }
  const subtle = globalThis.crypto.subtle;
  const imported = await subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', imported, message as BufferSource);
  return new Uint8Array(sig);
}

export async function sha256(message: Uint8Array): Promise<Uint8Array> {
  if (isNode) {
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256');
    h.update(Buffer.from(message));
    return new Uint8Array(h.digest());
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    message as BufferSource,
  );
  return new Uint8Array(digest);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
