import { LIMITS } from './constants';
import type { NearlyError } from './errors';
import { validationError } from './errors';

/**
 * Reject control chars, bidi overrides, and zero-width chars.
 * `allowNewline` permits U+000A for multi-line fields like reason text.
 */
function isUnsafeChar(c: number): boolean {
  if (c < 0x20 && c !== 0x0a) return true;
  if (c === 0x7f) return true;
  if (c >= 0x200b && c <= 0x200f) return true;
  if (c >= 0x202a && c <= 0x202e) return true;
  if (c >= 0x2066 && c <= 0x2069) return true;
  if (c === 0xfeff) return true;
  return false;
}

function checkUnsafeUnicode(
  field: string,
  s: string,
  allowNewline: boolean,
): NearlyError | null {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (allowNewline && code === 0x0a) continue;
    if (isUnsafeChar(code)) {
      return validationError(
        field,
        `invalid character U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      );
    }
  }
  return null;
}

export function validateReason(reason: string): NearlyError | null {
  if (reason.length > LIMITS.REASON_MAX) {
    return validationError('reason', `max ${LIMITS.REASON_MAX} bytes`);
  }
  return checkUnsafeUnicode('reason', reason, true);
}

export function validateName(name: string): NearlyError | null {
  if (name.length > LIMITS.AGENT_NAME_MAX) {
    return validationError('name', `max ${LIMITS.AGENT_NAME_MAX} characters`);
  }
  if (name.trim().length === 0) {
    return validationError('name', 'must not be blank');
  }
  return checkUnsafeUnicode('name', name, false);
}

export function validateDescription(desc: string): NearlyError | null {
  if (desc.length > LIMITS.DESCRIPTION_MAX) {
    return validationError(
      'description',
      `max ${LIMITS.DESCRIPTION_MAX} bytes`,
    );
  }
  return checkUnsafeUnicode('description', desc, true);
}

/** Private-host detection — refuses localhost, RFC-1918, link-local, IPv6
 *  private ranges, and common decimal/octal/hex IP obfuscations. Ported
 *  from the frontend's `isPrivateHost` to keep the SSRF guard identical
 *  between the HTTP proxy path and the SDK's direct-OutLayer path. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();

  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1')
    return true;

  if (h.includes(':')) {
    const stripped = h.replace(/[0:]/g, '');
    if (stripped === '' || stripped === '1') return true;
  }

  if (h.startsWith('127.')) return true;
  if (h.startsWith('169.254.')) return true;
  if (h.startsWith('10.')) return true;
  if (h.startsWith('192.168.')) return true;

  if (h.startsWith('172.')) {
    const second = h.split('.')[1];
    if (second !== undefined) {
      const oct = parseInt(second, 10);
      if (oct >= 16 && oct <= 31) return true;
    }
  }

  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (h.startsWith('fc00:')) return true;
  if (h.startsWith('fd') && h.includes(':')) return true;

  if (h.startsWith('::ffff:10.')) return true;
  if (h.startsWith('::ffff:127.')) return true;
  if (h.startsWith('::ffff:169.254.')) return true;
  if (h.startsWith('::ffff:192.168.')) return true;
  if (h.startsWith('::ffff:172.')) {
    const rest = h.slice(7);
    if (rest.startsWith('172.')) {
      const second = rest.split('.')[1];
      if (second !== undefined) {
        const oct = parseInt(second, 10);
        if (oct >= 16 && oct <= 31) return true;
      }
    }
  }

  if (/^\d+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true;
  if (h.includes('.')) {
    const segs = h.split('.');
    if (
      segs.every((s) => s.length > 0 && /^[0-7]+$/.test(s)) &&
      segs.some((s) => s.length > 1 && s.startsWith('0'))
    )
      return true;
  }

  return false;
}

export function validateImageUrl(url: string): NearlyError | null {
  if (url.length > LIMITS.IMAGE_URL_MAX) {
    return validationError('image', `max ${LIMITS.IMAGE_URL_MAX} bytes`);
  }
  if (!url.startsWith('https://')) {
    return validationError('image', 'must use https://');
  }
  const afterScheme = url.slice('https://'.length);
  const authority = afterScheme.split('/')[0] ?? '';
  if (authority.includes('@')) {
    return validationError('image', 'must not contain credentials');
  }
  let hostname: string;
  if (authority.startsWith('[')) {
    hostname = (authority.split(']')[0] ?? '').slice(1);
  } else {
    hostname = authority.split(':')[0] ?? '';
  }
  if (!hostname) {
    return validationError('image', 'must have a valid host');
  }
  if (isPrivateHost(hostname)) {
    return validationError(
      'image',
      'must not point to local or internal hosts',
    );
  }
  return checkUnsafeUnicode('image', url, false);
}

/**
 * Normalize + validate a tag list. Returns `{validated}` on success with
 * lowercase-deduped order preserved, or `{error}` on the first failure.
 * Matches the frontend's `validateTags` wire shape exactly so round-trip
 * tag storage is identical whether written via proxy or SDK.
 */
export function validateTags(
  tags: readonly string[],
):
  | { validated: string[]; error: null }
  | { validated: null; error: NearlyError } {
  if (tags.length > LIMITS.MAX_TAGS) {
    return {
      validated: null,
      error: validationError('tags', `max ${LIMITS.MAX_TAGS} tags`),
    };
  }
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (!t) {
      return {
        validated: null,
        error: validationError('tags', 'tag must not be empty'),
      };
    }
    if (t.length > LIMITS.MAX_TAG_LEN) {
      return {
        validated: null,
        error: validationError(
          'tags',
          `tag must be at most ${LIMITS.MAX_TAG_LEN} characters`,
        ),
      };
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(t)) {
      return {
        validated: null,
        error: validationError(
          'tags',
          'tags must be lowercase alphanumeric with interior hyphens (no leading or trailing hyphens)',
        ),
      };
    }
    if (!seen.has(t)) {
      seen.add(t);
      validated.push(t);
    }
  }
  return { validated, error: null };
}

function validateCapabilitiesContent(
  val: unknown,
  depth: number,
): NearlyError | null {
  if (depth > LIMITS.MAX_CAPABILITY_DEPTH) {
    return validationError(
      'capabilities',
      `exceed maximum nesting depth of ${LIMITS.MAX_CAPABILITY_DEPTH}`,
    );
  }
  if (typeof val === 'string') {
    const u = checkUnsafeUnicode('capabilities', val, false);
    if (u) return u;
    if (val.includes(':')) {
      return validationError('capabilities', 'value must not contain colons');
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      const e = validateCapabilitiesContent(item, depth + 1);
      if (e) return e;
    }
  } else if (typeof val === 'object' && val !== null) {
    for (const [key, child] of Object.entries(val)) {
      const u = checkUnsafeUnicode('capabilities', key, false);
      if (u) return u;
      if (key.includes(':')) {
        return validationError('capabilities', 'key must not contain colons');
      }
      const e = validateCapabilitiesContent(child, depth + 1);
      if (e) return e;
    }
  }
  return null;
}

export function validateCapabilities(caps: unknown): NearlyError | null {
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    return validationError('capabilities', 'must be a JSON object');
  }
  const serialized = JSON.stringify(caps);
  if (serialized.length > LIMITS.CAPABILITIES_MAX) {
    return validationError(
      'capabilities',
      `max ${LIMITS.CAPABILITIES_MAX} bytes`,
    );
  }
  return validateCapabilitiesContent(caps, 0);
}

/**
 * Validate a sub-agent `seed` string for `NearlyClient.deriveSubAgent`.
 * OutLayer's only documented constraint is "seed must not be empty" (see
 * the error table in `.agents/skills/agent-custody/SKILL.md`). We also
 * cap length at `LIMITS.SEED_MAX` as a caller-sanity guard — this is
 * *not* an OutLayer rule and can be relaxed. No other constraints:
 * seeds flow through as JSON string field values, not as FastData keys.
 */
export function validateSeed(seed: string): NearlyError | null {
  if (seed.length === 0) {
    return validationError('seed', 'must not be empty');
  }
  if (seed.length > LIMITS.SEED_MAX) {
    return validationError('seed', `max ${LIMITS.SEED_MAX} characters`);
  }
  return null;
}

/**
 * Validate a FastData KV `key_suffix` under a fixed `key_prefix`. The
 * composed FastData key is `key_prefix + key_suffix`; this enforces
 * non-empty, no leading slash, unicode-safe, no null bytes, and the
 * 1024-byte full-key limit. Generic — any handler composing a FastData
 * key from a convention prefix plus a caller-supplied tail uses this.
 */
export function validateKeySuffix(
  keySuffix: string,
  keyPrefix: string,
): NearlyError | null {
  if (!keySuffix) return validationError('key_suffix', 'must not be empty');
  if (keySuffix.startsWith('/'))
    return validationError('key_suffix', 'must not start with /');
  const u = checkUnsafeUnicode('key_suffix', keySuffix, false);
  if (u) return u;
  const fullKey = `${keyPrefix}${keySuffix}`;
  if (fullKey.includes('\0'))
    return validationError('key_suffix', 'key must not contain null bytes');
  // TextEncoder is browser+Node native; avoids Node-only Buffer.
  const byteLen = new TextEncoder().encode(fullKey).length;
  if (byteLen > LIMITS.FASTDATA_MAX_KEY_BYTES) {
    return validationError(
      'key_suffix',
      `key_prefix + key_suffix exceeds ${LIMITS.FASTDATA_MAX_KEY_BYTES}-byte limit`,
    );
  }
  return null;
}
