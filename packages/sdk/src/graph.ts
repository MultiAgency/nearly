import { LIMITS } from './constants';
import type { Agent, KvEntry } from './types';

/**
 * Fold a single KvEntry into an Agent, applying FastData's trust boundary:
 *
 * - `account_id` — overridden with the entry's `predecessor_id`, because
 *   FastData attributes each key to whoever wrote it, not to whatever the
 *   caller wrote into the stored blob.
 * - `last_active` / `last_active_height` — overridden with the block-time
 *   and block-height of the entry, because caller-asserted activity time
 *   is manipulable. An agent could write `last_active: 9999999999` into
 *   their profile blob and appear eternally fresh in `sort=active`;
 *   overriding on read closes that hole without touching writers.
 *   `last_active_height` is the canonical monotonic cursor; `last_active`
 *   is its seconds-since-epoch display companion.
 *
 * Returns null for non-object blobs. The `!Array.isArray` guard matters:
 * `typeof [] === 'object'` is true, so without it an array stored under
 * `profile` would spread into `{0: ..., 1: ..., account_id: id}` — a
 * valid-looking Agent with numeric-string keys.
 */
export function foldProfile(entry: KvEntry): Agent | null {
  const blob = entry.value;
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  // Destructure-and-rebuild instead of spread-and-override. Every trust-
  // boundary and derived field is pulled out of the blob so `safe` carries
  // only canonical self-authored content (name, description, image, tags,
  // capabilities); the authoritative block-derived values are added back in
  // the return. `created_at` / `created_height` are NOT added back here —
  // only read paths that fetch first-write history (`getAgent`, `listAgents`
  // with `sort=newest`) repopulate them. Count / endorsement fields are
  // also stripped: the write side removes them before storage, and any
  // legacy blob that still carries them would otherwise leak stale values
  // into list reads that don't overlay live counts. Mirrors the write-side
  // strip in `profileEntries` and stays symmetric with `applyTrustBoundary`
  // in `frontend/src/lib/fastdata-utils`.
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
