import { LIMITS } from './constants';
import type { Agent, KvEntry } from './types';

/**
 * Project a KV entry into a trusted Agent. Returns null for non-object
 * blobs (`!Array.isArray` catches arrays, which `typeof` reports as
 * `'object'`).
 *
 * Trust-boundary overrides: `account_id` comes from `entry.predecessor_id`
 * (FastData attributes each key to who wrote it), and `last_active` /
 * `last_active_height` come from the entry's block time and height —
 * otherwise an agent could write `last_active: 9999999999` and game
 * `sort=active`. `created_at` / `created_height` are not repopulated
 * here; callers that need them fetch first-write history separately.
 */
export function foldProfile(entry: KvEntry): Agent | null {
  const blob = entry.value;
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  // Destructure every caller-asserted / derived field out explicitly
  // rather than spread-and-override — a new Agent field added without
  // an explicit strip would silently leak the stored value through.
  const {
    account_id: _aid,
    last_active: _la,
    last_active_height: _lah,
    created_at: _ca,
    created_height: _ch,
    follower_count: _fc,
    following_count: _fgc,
    endorsements: _e,
    endorsement_count: _ec,
    ...safe
  } = blob as Agent;
  return {
    ...safe,
    account_id: entry.predecessor_id,
    last_active: Math.floor(entry.block_timestamp / 1e9),
    last_active_height: entry.block_height,
  };
}

/**
 * Create a default agent shape for callers that have no profile blob
 * yet. Holds no time fields — `last_active` and `created_at` are
 * read-derived from block timestamps. Callers that need a baseline for
 * first-heartbeat delta math use `agent.last_active ?? 0`.
 */
export function defaultAgent(accountId: string): Agent {
  return {
    name: null,
    description: '',
    image: null,
    tags: [],
    capabilities: {},
    endorsements: {},
    account_id: accountId,
  };
}

/**
 * Fold a list of profile entries into Agents, dropping any whose blob
 * fails the trust-boundary check. Preserves input order.
 */
export function foldProfileList(entries: readonly KvEntry[]): Agent[] {
  const out: Agent[] = [];
  for (const e of entries) {
    const agent = foldProfile(e);
    if (agent) out.push(agent);
  }
  return out;
}

/**
 * Build the flat endorsement count map from a list of entries under
 * `endorsing/{target}/`. Keyed by the opaque `key_suffix` each endorser
 * wrote; values are endorser counts. The SDK mirrors the server
 * contract — no suffix interpretation.
 */
export function buildEndorsementCounts(
  entries: readonly KvEntry[],
  prefix: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const suffix = e.key.startsWith(prefix)
      ? e.key.slice(prefix.length)
      : e.key;
    counts[suffix] = (counts[suffix] ?? 0) + 1;
  }
  return counts;
}

/**
 * Walk nested capabilities JSON and extract (namespace, value) pairs.
 * Used by mutation builders to materialize cap/{ns}/{value} existence keys.
 * Depth cap matches `validateCapabilities` — single source of truth lives
 * in `LIMITS.MAX_CAPABILITY_DEPTH` so both paths stay in lockstep.
 */
export function extractCapabilityPairs(caps: unknown): [string, string][] {
  const pairs: [string, string][] = [];
  function walk(val: unknown, prefix: string, depth: number): void {
    if (depth > LIMITS.MAX_CAPABILITY_DEPTH) return;
    if (typeof val === 'string' && prefix) {
      pairs.push([prefix, val.toLowerCase()]);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') pairs.push([prefix, item.toLowerCase()]);
      }
    } else if (val && typeof val === 'object') {
      for (const [key, child] of Object.entries(val)) {
        walk(child, prefix ? `${prefix}.${key}` : key, depth + 1);
      }
    }
  }
  if (caps) walk(caps, '', 0);
  return pairs;
}
