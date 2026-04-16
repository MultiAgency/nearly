/**
 * FastData KV write path for social graph mutations.
 *
 * Handles all non-registration mutations via direct FastData writes.
 * Each function validates inputs, checks rate limits, writes via
 * the caller's custody wallet, and returns a structured response.
 *
 * Key schema (per-predecessor — caller writes under their own account):
 *   graph/follow/{targetAccountId}        → {reason?}
 *   endorsing/{targetAccountId}/{key_suffix} → {reason?, content_hash?}
 *   profile                               → full Agent record
 *   tag/{tag}                             → true (existence index)
 *
 * Edge values carry no `at` — the authoritative "when" is FastData's
 * indexed `block_height` / `block_timestamp`, surfaced on read via
 * `entryBlockHeight` / `entryBlockSecs`.
 */

import {
  buildDelistMe,
  buildEndorse,
  buildFollow,
  buildHeartbeat,
  buildUnendorse,
  buildUnfollow,
  buildUpdateMe,
  LIMITS,
  type UpdateMePatch,
} from '@nearly/sdk';
import type { Agent } from '@/types';
import {
  EXTERNAL_URLS,
  FASTDATA_NAMESPACE,
  FUND_AMOUNT_NEAR,
  OUTLAYER_API_URL,
} from './constants';
import {
  kvGetAgent,
  kvGetAll,
  kvListAgent,
  kvListAll,
  kvMultiAgent,
} from './fastdata';
import {
  buildEndorsementCounts,
  composeKey,
  endorsePrefix,
  entryBlockHeight,
  fetchProfile,
  fetchProfiles,
  liveNetworkCounts,
  profileCompleteness,
  profileSummary,
} from './fastdata-utils';
import { fetchWithTimeout } from './fetch';
import {
  checkRateLimit,
  checkRateLimitBudget,
  incrementRateLimit,
} from './rate-limit';
import {
  type ValidationError,
  validateCapabilities,
  validateDescription,
  validateImageUrl,
  validateKeySuffix,
  validateName,
  validateReason,
  validateTags,
} from './validate';

const BALANCE_CHECK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export type WriteResult =
  | {
      success: true;
      data: Record<string, unknown>;
      /** Cache action types this mutation invalidates. Null = clear all. */
      invalidates: readonly string[] | null;
    }
  | {
      success: false;
      error: string;
      code: string;
      status: number;
      retryAfter?: number;
      meta?: Record<string, unknown>;
    };

function ok(data: Record<string, unknown>): WriteResult {
  return { success: true, data, invalidates: [] };
}

function fail(code: string, message: string, status = 400): WriteResult {
  return { success: false, error: message, code, status };
}

function rateLimited(retryAfter: number): WriteResult {
  return {
    success: false,
    error: `Rate limit exceeded. Retry after ${retryAfter}s.`,
    code: 'RATE_LIMITED',
    status: 429,
    retryAfter,
  };
}

function validationFail(e: ValidationError): WriteResult {
  return fail(e.code, e.message);
}

function walletFundingMeta(accountId: string): Record<string, unknown> {
  return {
    wallet_address: accountId,
    fund_amount: FUND_AMOUNT_NEAR,
    fund_token: 'NEAR',
    fund_url: EXTERNAL_URLS.OUTLAYER_FUND(accountId),
  };
}

function insufficientBalance(accountId: string): WriteResult {
  return {
    success: false,
    error: `Fund your wallet with ≥${FUND_AMOUNT_NEAR} NEAR, then retry.`,
    code: 'INSUFFICIENT_BALANCE',
    status: 402,
    meta: walletFundingMeta(accountId),
  };
}

function writeFailureToResult(
  wrote: Extract<WriteOutcome, { ok: false }>,
  accountId: string,
): WriteResult {
  return wrote.reason === 'insufficient_balance'
    ? insufficientBalance(accountId)
    : fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
}

function targetGuardError(
  targetAccountId: string,
  callerAccountId: string,
  selfCode: string,
  verb: string,
): Record<string, unknown> | null {
  if (!targetAccountId.trim()) {
    return {
      account_id: targetAccountId,
      action: 'error',
      code: 'VALIDATION_ERROR',
      error: 'empty account_id',
    };
  }
  if (targetAccountId === callerAccountId) {
    return {
      account_id: targetAccountId,
      action: 'error',
      code: selfCode,
      error: `cannot ${verb} yourself`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// FastData KV write (awaitable — primary write path, not fire-and-forget)
// ---------------------------------------------------------------------------

export type WriteOutcome =
  | { ok: true }
  | { ok: false; reason: 'insufficient_balance' | 'storage_error' };

// Fail-closed on ambiguity: HTTP failures and malformed bodies return
// false so an upstream outage is never misclassified as a drained wallet.
async function hasZeroNearBalance(walletKey: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${OUTLAYER_API_URL}/wallet/v1/balance?chain=near`,
      { headers: { Authorization: `Bearer ${walletKey}` } },
      BALANCE_CHECK_TIMEOUT_MS,
    );
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as {
      balance?: string;
    } | null;
    return data?.balance === '0';
  } catch {
    return false;
  }
}

export async function writeToFastData(
  walletKey: string,
  entries: Record<string, unknown>,
): Promise<WriteOutcome> {
  const url = `${OUTLAYER_API_URL}/wallet/v1/call`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${walletKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receiver_id: FASTDATA_NAMESPACE,
          method_name: '__fastdata_kv',
          args: entries,
          gas: '30000000000000',
          deposit: '0',
        }),
      },
      15_000,
    );
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => '');
    console.error(
      `[fastdata-write] http ${res.status}: ${detail.slice(0, 200)}`,
    );
    // Zero-balance writes return 502 + text/plain (Cloudflare upstream),
    // so probe the balance endpoint to disambiguate a genuine outage from
    // an unfunded wallet — a funded wallet hitting a real outage must
    // stay STORAGE_ERROR so the caller retries instead of prompting to fund.
    if (res.status === 502 && (await hasZeroNearBalance(walletKey))) {
      return { ok: false, reason: 'insufficient_balance' };
    }
    return { ok: false, reason: 'storage_error' };
  } catch (err) {
    console.error('[fastdata-write] network error:', err);
    return { ok: false, reason: 'storage_error' };
  }
}

// ---------------------------------------------------------------------------
// Resolve caller identity
// ---------------------------------------------------------------------------

interface CallerIdentity {
  accountId: string;
  agent: Agent;
}

// No time fields: `last_active` / `created_at` are read-derived from
// block timestamps and have no honest write-side value before the first
// read.
function defaultAgent(accountId: string): Agent {
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

// Nearly does not gate profile creation — any authenticated `wk_` can
// mutate, and the first profile-writing mutation (heartbeat or update_me)
// bootstraps the profile blob. Edge-only callers stay invisible to
// `list_agents` until that first profile write lands.
async function resolveCallerOrInit(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<CallerIdentity | WriteResult> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return fail('AUTH_FAILED', 'Could not resolve account', 401);

  const existing = await fetchProfile(accountId);
  return { accountId, agent: existing ?? defaultAgent(accountId) };
}

// ---------------------------------------------------------------------------
// Batch scaffolding shared by follow/unfollow/endorse/unendorse
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 20;

type BatchAction =
  | 'social.follow'
  | 'social.unfollow'
  | 'social.endorse'
  | 'social.unendorse';

type BatchStep =
  | { kind: 'skip'; result: Record<string, unknown> }
  | { kind: 'fail'; result: Record<string, unknown> }
  | {
      kind: 'write';
      entries: Record<string, unknown>;
      onWritten: () => Record<string, unknown>;
    };

interface BatchOptions {
  action: BatchAction;
  selfCode: string;
  verb: string;
  walletKey: string;
  body: Record<string, unknown>;
  resolveAccountId: (wk: string) => Promise<string | null>;
  step: (target: string, caller: CallerIdentity) => Promise<BatchStep>;
  finalize?: (
    results: Record<string, unknown>[],
    caller: CallerIdentity,
    processed: number,
  ) => Promise<Record<string, unknown>>;
}

// A 402 on any write aborts the batch with INSUFFICIENT_BALANCE — no
// subsequent target would succeed with an underfunded wallet, and the
// caller needs the fund link, not N misleading STORAGE_ERROR items.
async function runBatch(opts: BatchOptions): Promise<WriteResult> {
  const targets = resolveTargets(opts.body);
  if (!Array.isArray(targets)) return targets;
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);

  const caller = await resolveCallerOrInit(
    opts.walletKey,
    opts.resolveAccountId,
  );
  if ('success' in caller) return caller;

  const budget = checkRateLimitBudget(opts.action, caller.accountId);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const results: Record<string, unknown>[] = [];
  let processed = 0;

  for (const target of targets) {
    const guard = targetGuardError(
      target,
      caller.accountId,
      opts.selfCode,
      opts.verb,
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const step = await opts.step(target, caller);
    if (step.kind !== 'write') {
      results.push(step.result);
      continue;
    }

    if (processed >= budget.remaining) {
      results.push({
        account_id: target,
        action: 'error',
        code: 'RATE_LIMITED',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const wrote = await writeToFastData(opts.walletKey, step.entries);
    if (!wrote.ok) {
      if (wrote.reason === 'insufficient_balance') {
        return insufficientBalance(caller.accountId);
      }
      results.push({
        account_id: target,
        action: 'error',
        code: 'STORAGE_ERROR',
        error: 'storage error',
      });
      continue;
    }

    incrementRateLimit(opts.action, caller.accountId, budget.window);
    processed++;
    results.push(step.onWritten());
  }

  const payload = opts.finalize
    ? await opts.finalize(results, caller, processed)
    : { results };
  return ok(payload);
}

// ---------------------------------------------------------------------------
// Follow / Unfollow
// ---------------------------------------------------------------------------

export async function handleFollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const reason = body.reason as string | undefined;
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }

  return runBatch({
    action: 'social.follow',
    selfCode: 'SELF_FOLLOW',
    verb: 'follow',
    walletKey,
    body,
    resolveAccountId,
    step: async (target, caller) => {
      const followKey = composeKey('graph/follow/', target);
      const existing = await kvGetAgent(caller.accountId, followKey);
      if (existing) {
        return {
          kind: 'skip',
          result: { account_id: target, action: 'already_following' },
        };
      }
      const targetAgent = await fetchProfile(target);
      if (!targetAgent) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'NOT_FOUND',
            error: 'agent not found',
          },
        };
      }
      const mutation = buildFollow(
        caller.accountId,
        target,
        reason != null ? { reason } : undefined,
      );
      return {
        kind: 'write',
        entries: mutation.entries,
        onWritten: () => ({ account_id: target, action: 'followed' }),
      };
    },
    finalize: async (results, caller, processed) => {
      const counts = await liveNetworkCounts(caller.accountId);
      return {
        results,
        your_network: {
          following_count: counts.following_count + processed,
          follower_count: counts.follower_count,
        },
      };
    },
  });
}

export async function handleUnfollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  return runBatch({
    action: 'social.unfollow',
    selfCode: 'SELF_UNFOLLOW',
    verb: 'unfollow',
    walletKey,
    body,
    resolveAccountId,
    // No target-exists check — you can remove an edge to a deleted account.
    step: async (target, caller) => {
      const followKey = composeKey('graph/follow/', target);
      const existing = await kvGetAgent(caller.accountId, followKey);
      if (!existing) {
        return {
          kind: 'skip',
          result: { account_id: target, action: 'not_following' },
        };
      }
      const mutation = buildUnfollow(caller.accountId, target);
      return {
        kind: 'write',
        entries: mutation.entries,
        onWritten: () => ({ account_id: target, action: 'unfollowed' }),
      };
    },
    finalize: async (results, caller, processed) => {
      const counts = await liveNetworkCounts(caller.accountId);
      return {
        results,
        your_network: {
          following_count: Math.max(0, counts.following_count - processed),
          follower_count: counts.follower_count,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Endorse / Unendorse
// ---------------------------------------------------------------------------

function resolveKeySuffixes(
  body: Record<string, unknown>,
): { keySuffixes: string[] } | WriteResult {
  const raw = body.key_suffixes;
  if (!Array.isArray(raw) || raw.length === 0)
    return fail('VALIDATION_ERROR', 'key_suffixes array must not be empty');
  if (raw.length > LIMITS.MAX_KEY_SUFFIXES)
    return fail(
      'VALIDATION_ERROR',
      `Too many key_suffixes (max ${LIMITS.MAX_KEY_SUFFIXES})`,
    );
  // Dedupe: duplicate key_suffixes in a single call would write the same
  // KV key twice and return misleading duplicate entries in endorsed[].
  // Order-preserving: first occurrence wins.
  const seen = new Set<string>();
  const keySuffixes: string[] = [];
  for (const ks of raw) {
    if (typeof ks !== 'string')
      return fail('VALIDATION_ERROR', 'key_suffixes must be strings');
    if (seen.has(ks)) continue;
    seen.add(ks);
    keySuffixes.push(ks);
  }
  return { keySuffixes };
}

export async function handleEndorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const keySuffixesResult = resolveKeySuffixes(body);
  if ('success' in keySuffixesResult) return keySuffixesResult;
  const { keySuffixes } = keySuffixesResult;

  const reason = body.reason as string | undefined;
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }
  const contentHash = body.content_hash as string | undefined;

  return runBatch({
    action: 'social.endorse',
    selfCode: 'SELF_ENDORSE',
    verb: 'endorse',
    walletKey,
    body,
    resolveAccountId,
    // Rate-limit unit: one per target regardless of key_suffixes count.
    step: async (target, caller) => {
      if ((await fetchProfile(target)) == null) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'NOT_FOUND',
            error: 'agent not found',
          },
        };
      }

      const keyPrefix = endorsePrefix(target);
      const validKeySuffixes: string[] = [];
      const skipped: { key_suffix: string; reason: string }[] = [];
      for (const ks of keySuffixes) {
        const e = validateKeySuffix(ks, keyPrefix);
        if (e) skipped.push({ key_suffix: ks, reason: e.message });
        else validKeySuffixes.push(ks);
      }

      if (validKeySuffixes.length === 0) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'VALIDATION_ERROR',
            error: 'no valid key_suffixes',
            ...(skipped.length > 0 && { skipped }),
          },
        };
      }

      const fullKeys = validKeySuffixes.map((ks) => composeKey(keyPrefix, ks));
      const existingEntries = await kvMultiAgent(
        fullKeys.map((key) => ({ accountId: caller.accountId, key })),
      );

      // Skip suffixes whose stored `content_hash` already matches; last
      // write wins on mismatch.
      const suffixesToWrite: string[] = [];
      const endorsed: string[] = [];
      const alreadyEndorsed: string[] = [];

      for (let i = 0; i < validKeySuffixes.length; i++) {
        const ks = validKeySuffixes[i]!;
        const existing = existingEntries[i]?.value as
          | { content_hash?: string }
          | null
          | undefined;
        const existingHash = existing?.content_hash;
        const sameHash = contentHash
          ? existingHash === contentHash
          : existingHash == null;
        if (existing && sameHash) {
          alreadyEndorsed.push(ks);
          continue;
        }
        suffixesToWrite.push(ks);
        endorsed.push(ks);
      }

      const entries: Record<string, unknown> =
        suffixesToWrite.length > 0
          ? buildEndorse(caller.accountId, target, {
              keySuffixes: suffixesToWrite,
              ...(reason != null && { reason }),
              ...(contentHash != null && { contentHash }),
            }).entries
          : {};

      const buildResult = (): Record<string, unknown> => {
        const result: Record<string, unknown> = {
          account_id: target,
          action: 'endorsed',
          endorsed,
        };
        if (alreadyEndorsed.length > 0)
          result.already_endorsed = alreadyEndorsed;
        if (skipped.length > 0) result.skipped = skipped;
        return result;
      };

      if (endorsed.length === 0) {
        return { kind: 'skip', result: buildResult() };
      }
      return { kind: 'write', entries, onWritten: buildResult };
    },
  });
}

export async function handleUnendorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const keySuffixesResult = resolveKeySuffixes(body);
  if ('success' in keySuffixesResult) return keySuffixesResult;
  const { keySuffixes } = keySuffixesResult;

  return runBatch({
    action: 'social.unendorse',
    selfCode: 'SELF_UNENDORSE',
    verb: 'unendorse',
    walletKey,
    body,
    resolveAccountId,
    step: async (target, caller) => {
      // Read only the caller's own keys — gating on the target's
      // current profile would break retraction after the target mutated,
      // and scanning every endorsement on this target is the high-fanout
      // cliff. Validation rules mirror endorse so a retract can't land
      // on a key the endorse path would reject; partition into valid /
      // skipped for per-suffix caller feedback. No "retract everything"
      // path — callers compose the key_suffix list themselves.
      const keyPrefix = endorsePrefix(target);
      const validKeySuffixes: string[] = [];
      const skipped: { key_suffix: string; reason: string }[] = [];
      for (const ks of keySuffixes) {
        const e = validateKeySuffix(ks, keyPrefix);
        if (e) skipped.push({ key_suffix: ks, reason: e.message });
        else validKeySuffixes.push(ks);
      }

      if (validKeySuffixes.length === 0) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'VALIDATION_ERROR',
            error: 'no valid key_suffixes',
            ...(skipped.length > 0 && { skipped }),
          },
        };
      }

      const fullKeys = validKeySuffixes.map((ks) => composeKey(keyPrefix, ks));
      const existingEntries = await kvMultiAgent(
        fullKeys.map((key) => ({ accountId: caller.accountId, key })),
      );

      // FastData no-ops null-writes on absent keys, so the filter is for
      // response accuracy only — `removed` must list only edges that
      // actually transitioned live → tombstone.
      const removed: string[] = [];
      for (let i = 0; i < validKeySuffixes.length; i++) {
        if (existingEntries[i] != null) {
          removed.push(validKeySuffixes[i]!);
        }
      }

      const entries: Record<string, unknown> =
        removed.length > 0
          ? buildUnendorse(caller.accountId, target, removed).entries
          : {};

      const result: Record<string, unknown> = {
        account_id: target,
        action: 'unendorsed',
        removed,
      };
      if (skipped.length > 0) result.skipped = skipped;

      if (removed.length === 0) {
        return { kind: 'skip', result };
      }
      return { kind: 'write', entries, onWritten: () => result };
    },
  });
}

// ---------------------------------------------------------------------------
// Update Me
// ---------------------------------------------------------------------------

export async function handleUpdateMe(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // First-write creates a default profile if none exists.
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('social.update_me', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);
  const rlWindow = rl.window;

  // Validation runs here (not inside `buildUpdateMe`) so failures land
  // as structured `WriteResult`s — the SDK builder throws, which would
  // require try/catch translation at every call site.
  const agent = { ...caller.agent };
  const patch: UpdateMePatch = {};
  let changed = false;

  if ('name' in body) {
    const name = body.name as string | null;
    if (name != null) {
      const e = validateName(name);
      if (e) return validationFail(e);
    }
    agent.name = name;
    patch.name = name;
    changed = true;
  }
  if (typeof body.description === 'string') {
    const e = validateDescription(body.description);
    if (e) return validationFail(e);
    agent.description = body.description;
    patch.description = body.description;
    changed = true;
  }
  if ('image' in body) {
    const url = body.image as string | null;
    if (url != null) {
      const e = validateImageUrl(url);
      if (e) return validationFail(e);
    }
    agent.image = url;
    patch.image = url;
    changed = true;
  }
  if (Array.isArray(body.tags)) {
    const { validated, error } = validateTags(body.tags as string[]);
    if (error) return validationFail(error);
    agent.tags = validated;
    patch.tags = validated;
    changed = true;
  }
  if (body.capabilities !== undefined) {
    const e = validateCapabilities(body.capabilities);
    if (e) return validationFail(e);
    agent.capabilities = body.capabilities as Agent['capabilities'];
    patch.capabilities = body.capabilities as Agent['capabilities'];
    changed = true;
  }

  if (!changed) {
    return fail(
      'VALIDATION_ERROR',
      'No valid fields to update (supported: name, description, image, tags, capabilities)',
    );
  }

  // Dropped tags and capability pairs must emit explicit null-writes —
  // otherwise `list_tags` / `list_capabilities` keep returning ghost indexes.
  const { entries } = buildUpdateMe(caller.accountId, caller.agent, patch);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return writeFailureToResult(wrote, caller.accountId);

  incrementRateLimit('social.update_me', caller.accountId, rlWindow);

  // Overlay live counts on the response so clients receive the same agent
  // shape as heartbeat returns (stored profiles don't carry count fields).
  const counts = await liveNetworkCounts(caller.accountId);
  const responseAgent: Agent = { ...agent, ...counts };
  return ok({
    agent: responseAgent,
    profile_completeness: profileCompleteness(responseAgent),
  });
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export async function handleHeartbeat(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // First-write creates a default profile if none exists.
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('social.heartbeat', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);
  const rlWindow = rl.window;

  // Edge comparisons below use `entryBlockHeight(e) > previousActiveHeight`
  // — strictly-after matches the activity-query cursor and prevents
  // re-surfacing edges the caller already saw on their prior heartbeat.
  // `previousActive` (seconds) is retained only to populate `delta.since`
  // for consumers not yet migrated to `since_height`. On first heartbeat
  // `caller.agent` is the in-memory `defaultAgent` with no
  // `last_active_height`; the `?? 0` fallback surfaces every pre-existing
  // follower edge as new.
  const previousActive = caller.agent.last_active ?? 0;
  const previousActiveHeight = caller.agent.last_active_height ?? 0;
  const agent = { ...caller.agent };

  const [followerEntries, followingEntries, endorseEntries] = await Promise.all(
    [
      kvGetAll(`graph/follow/${caller.accountId}`),
      kvListAgent(caller.accountId, 'graph/follow/'),
      kvListAll(endorsePrefix(caller.accountId)),
    ],
  );
  agent.endorsements = buildEndorsementCounts(endorseEntries, caller.accountId);

  // Filtering on FastData-indexed `block_height` closes the backdate /
  // forge vector — a follower cannot fabricate a value-blob timestamp
  // to hide from or inject into this delta.
  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    if (entryBlockHeight(e) > previousActiveHeight) {
      newFollowerAccounts.push(e.predecessor_id);
    }
  }

  const newFollowingCount = followingEntries.filter(
    (e) => entryBlockHeight(e) > previousActiveHeight,
  ).length;

  const newFollowers = (await fetchProfiles(newFollowerAccounts)).map(
    profileSummary,
  );

  // No tombstones emitted (heartbeat is a pure index refresh, not a diff —
  // a reader might otherwise expect dropped tags to null-write).
  const { entries } = buildHeartbeat(caller.accountId, agent);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return writeFailureToResult(wrote, caller.accountId);

  incrementRateLimit('social.heartbeat', caller.accountId, rlWindow);

  const responseAgent: Agent = {
    ...agent,
    follower_count: followerEntries.length,
    following_count: followingEntries.length,
  };

  return ok({
    agent: responseAgent,
    profile_completeness: profileCompleteness(responseAgent),
    delta: {
      since: previousActive,
      since_height: previousActiveHeight,
      new_followers: newFollowers,
      new_followers_count: newFollowers.length,
      new_following_count: newFollowingCount,
    },
  });
}

// ---------------------------------------------------------------------------
// Delist Me
// ---------------------------------------------------------------------------

export async function handleDelistMe(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('social.delist_me', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);
  const rlWindow = rl.window;

  // Scan the caller's own outgoing edges so the delist envelope can
  // null-write every edge they authored. Follower edges written by
  // OTHER agents are intentionally NOT touched — retraction is the
  // writer's responsibility, not the subject's.
  const [followingEntries, endorsingEntries] = await Promise.all([
    kvListAgent(caller.accountId, 'graph/follow/'),
    kvListAgent(caller.accountId, 'endorsing/'),
  ]);

  const { entries } = buildDelistMe(
    caller.agent,
    followingEntries.map((e) => e.key),
    endorsingEntries.map((e) => e.key),
  );

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return writeFailureToResult(wrote, caller.accountId);

  incrementRateLimit('social.delist_me', caller.accountId, rlWindow);

  return ok({
    action: 'delisted',
    account_id: caller.accountId,
  });
}

// ---------------------------------------------------------------------------
// Invalidation map — co-located with mutations so new actions can't forget it.
// Unmapped actions invalidate all cached action types (safe default).
//
// `WRITE_ACTIONS` below is the authoritative list of every mutation this
// module dispatches, plus the admin mutations dispatched from `route.ts` via
// `writeToFastData` + `invalidatesFor`. A test in `fastdata-write.test.ts`
// asserts `WRITE_ACTIONS` and the `INVALIDATION_MAP` keys are the same set,
// so a new action added in the dispatch switch or a renamed action either
// fails CI or forces a deliberate map update.
// ---------------------------------------------------------------------------

export const WRITE_ACTIONS = [
  'hide_agent',
  'social.delist_me',
  'social.endorse',
  'social.follow',
  'social.heartbeat',
  'social.unendorse',
  'social.unfollow',
  'social.update_me',
  'unhide_agent',
] as const;

export type WriteAction = (typeof WRITE_ACTIONS)[number];

export const INVALIDATION_MAP: Record<string, readonly string[]> = {
  'social.update_me': [
    'list_agents',
    'list_tags',
    'list_capabilities',
    'profile',
  ],
  'social.follow': ['profile', 'followers', 'following', 'edges'],
  'social.unfollow': ['profile', 'followers', 'following', 'edges'],
  'social.endorse': ['profile', 'endorsers', 'endorsing'],
  'social.unendorse': ['profile', 'endorsers', 'endorsing'],
  'social.heartbeat': [
    'list_agents',
    'profile',
    'health',
    'list_tags',
    'list_capabilities',
  ],
  'social.delist_me': [
    'list_agents',
    'list_tags',
    'list_capabilities',
    'health',
    'profile',
    'followers',
    'following',
    'edges',
    'endorsers',
    'endorsing',
  ],
  hide_agent: ['hidden'],
  unhide_agent: ['hidden'],
};

/** Cached reads that a given mutation stales. Null means "clear everything". */
export function invalidatesFor(action: string): readonly string[] | null {
  return INVALIDATION_MAP[action] ?? null;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

// Reject non-string `targets[]` items at the boundary — a numeric item
// would crash downstream handlers on `.trim()`.
function resolveTargets(body: Record<string, unknown>): string[] | WriteResult {
  if (Array.isArray(body.targets)) {
    for (const t of body.targets) {
      if (typeof t !== 'string') {
        return fail('VALIDATION_ERROR', 'targets[] items must be strings');
      }
    }
    return body.targets as string[];
  }
  const accountId = body.account_id;
  if (typeof accountId !== 'string' || !accountId) {
    return fail('VALIDATION_ERROR', 'account_id is required');
  }
  return [accountId];
}

export async function dispatchWrite(
  action: string,
  body: Record<string, unknown>,
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  let result: WriteResult;

  switch (action) {
    case 'social.follow':
      result = await handleFollow(walletKey, body, resolveAccountId);
      break;
    case 'social.unfollow':
      result = await handleUnfollow(walletKey, body, resolveAccountId);
      break;
    case 'social.endorse':
      result = await handleEndorse(walletKey, body, resolveAccountId);
      break;
    case 'social.unendorse':
      result = await handleUnendorse(walletKey, body, resolveAccountId);
      break;
    case 'social.update_me':
      result = await handleUpdateMe(walletKey, body, resolveAccountId);
      break;
    case 'social.heartbeat':
      result = await handleHeartbeat(walletKey, resolveAccountId);
      break;
    case 'social.delist_me':
      result = await handleDelistMe(walletKey, resolveAccountId);
      break;
    default:
      return fail(
        'VALIDATION_ERROR',
        `Action '${action}' not supported for direct write`,
      );
  }

  // Attach invalidation targets to successful results.
  if (result.success) {
    result.invalidates = INVALIDATION_MAP[action] ?? null;
  }
  return result;
}
