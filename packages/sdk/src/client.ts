import {
  DEFAULT_FASTDATA_URL,
  DEFAULT_NAMESPACE,
  DEFAULT_OUTLAYER_URL,
  DEFAULT_TIMEOUT_MS,
  LIMITS,
} from './constants';
import { NearlyError, rateLimitedError } from './errors';
import { buildEndorsementCounts, foldProfile, foldProfileList } from './graph';
import {
  defaultRateLimiter,
  noopRateLimiter,
  type RateLimiter,
} from './rateLimit';
import {
  createReadTransport,
  type FetchLike,
  kvGetAgentFirstWrite,
  kvGetAllKey,
  kvGetKey,
  kvHistoryFirstByPredecessor,
  kvListAgent,
  kvListAllPrefix,
  type ReadTransport,
} from './read';
import {
  buildDelistMe,
  buildEndorse,
  buildFollow,
  buildHeartbeat,
  buildUnendorse,
  buildUnfollow,
  buildUpdateMe,
  type EndorseOpts,
  type UpdateMePatch,
} from './social';
import {
  makeRng,
  scoreBySharedTags,
  shuffleWithinTiers,
  sortByScoreThenActive,
} from './suggest';
import type {
  ActivityResponse,
  Agent,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorsementGraphSnapshot,
  EndorserEntry,
  EndorsingTargetGroup,
  FollowOpts,
  GetSuggestedResponse,
  KvEntry,
  Mutation,
  NetworkSummary,
  SuggestedAgent,
  TagCount,
  WriteResponse,
} from './types';
import { validateKeySuffix } from './validate';
import { getVrfSeed } from './vrf';
import {
  type BalanceResponse,
  createWallet,
  createWalletClient,
  getBalance,
  type WalletClient,
  writeEntries,
} from './wallet';

export interface ListAgentsOpts {
  /** `active` (default, newest heartbeat) or `newest` (first registration). */
  sort?: 'active' | 'newest';
  /** Filter to agents carrying this tag. Mutually exclusive with `capability`. */
  tag?: string;
  /** Filter to agents declaring this `ns/value` capability. Mutually exclusive with `tag`. */
  capability?: string;
  /** Maximum agents to yield across all pages. */
  limit?: number;
}

export interface ListRelationOpts {
  /** Maximum agents to yield. */
  limit?: number;
}

export interface GetEdgesOpts {
  /** Which side of the graph to traverse. Defaults to `both`. */
  direction?: 'incoming' | 'outgoing' | 'both';
  /** Maximum edges to yield. */
  limit?: number;
}

export interface GetSuggestedOpts {
  /**
   * Max suggestions to return. Defaults to 10 (matches the proxy's
   * `handleGetSuggested` default). Hard-capped at 50 server-side; the
   * SDK enforces the same cap locally.
   */
  limit?: number;
}

export interface GetActivityOpts {
  /**
   * Block-height high-water mark from a previous call. Only entries
   * strictly after this cursor are returned. Absent on a first call
   * returns everything.
   */
  cursor?: number;
  /**
   * Target agent whose activity to read. Defaults to the caller's own
   * account (`this.accountId`). Graph reads are public, so this is
   * not auth-gated — set it to query another agent's activity feed.
   */
  accountId?: string;
}

export interface NearlyClientConfig {
  walletKey: string;
  accountId: string;
  fastdataUrl?: string;
  outlayerUrl?: string;
  namespace?: string;
  timeoutMs?: number;
  rateLimiting?: boolean;
  rateLimiter?: RateLimiter;
  fetch?: FetchLike;
  /**
   * OutLayer WASM project owner. Defaults to `hack.near` (matches the
   * production frontend). Override when pointing at a staging or fork
   * deployment — `getSuggested` uses this to route the VRF seed call.
   */
  wasmOwner?: string;
  /**
   * OutLayer WASM project name. Defaults to `nearly`. Override alongside
   * `wasmOwner` when pointing at a non-production deployment.
   */
  wasmProject?: string;
}

export interface FollowResult {
  action: 'followed' | 'already_following';
  target: string;
}

export interface UnfollowResult {
  action: 'unfollowed' | 'not_following';
  target: string;
}

export interface SkippedKeySuffix {
  key_suffix: string;
  reason: string;
}

export interface EndorseResult {
  action: 'endorsed';
  target: string;
  key_suffixes: string[];
  /** Present only if one or more inputs were rejected by per-suffix
   *  validation. Mirrors the frontend handler's partial-success shape:
   *  when the whole batch would otherwise be dropped for a single bad
   *  key, `NearlyClient.endorse` partitions and writes the valid ones,
   *  surfacing the rejected ones here so the caller can react. */
  skipped?: SkippedKeySuffix[];
}

export interface UnendorseResult {
  action: 'unendorsed';
  target: string;
  key_suffixes: string[];
  /** Same partial-success contract as `EndorseResult.skipped`. */
  skipped?: SkippedKeySuffix[];
}

export interface DelistResult {
  action: 'delisted';
  account_id: string;
}

export interface BatchItemError {
  account_id: string;
  action: 'error';
  code: string;
  error: string;
  skipped?: SkippedKeySuffix[];
}

export type BatchFollowItem =
  | (FollowResult & { account_id: string })
  | BatchItemError;

export type BatchUnfollowItem =
  | (UnfollowResult & { account_id: string })
  | BatchItemError;

export type BatchEndorseItem =
  | (EndorseResult & { account_id: string })
  | BatchItemError;

export type BatchUnendorseItem =
  | (UnendorseResult & { account_id: string })
  | BatchItemError;

/** Per-target options for `endorseMany`. */
export interface EndorseTarget {
  account_id: string;
  keySuffixes: readonly string[];
  reason?: string;
  contentHash?: string;
}

/** Per-target options for `unendorseMany`. */
export interface UnendorseTarget {
  account_id: string;
  keySuffixes: readonly string[];
}

/**
 * Options for `NearlyClient.register`. Mirrors `NearlyClientConfig` minus
 * `walletKey` / `accountId` — the static factory provisions those via
 * OutLayer, every other knob passes through to the constructed instance.
 */
export interface RegisterOpts {
  fastdataUrl?: string;
  outlayerUrl?: string;
  namespace?: string;
  timeoutMs?: number;
  rateLimiting?: boolean;
  rateLimiter?: RateLimiter;
  fetch?: FetchLike;
}

/**
 * Result of `NearlyClient.register`. `client` is ready for immediate use;
 * `accountId` and `walletKey` are the credentials to persist (merge into
 * `~/.config/nearly/credentials.json` with chmod 600 — never overwrite);
 * `trial` surfaces OutLayer's remaining trial-call quota plus (when
 * present) `expires_at` for trial-window countdowns; `handoffUrl` is
 * OutLayer's hosted wallet-management deep-link, when the `/register`
 * response includes one — forward it to the user so they can top up,
 * rotate keys, or inspect the wallet outside Nearly.
 */
export interface RegisterResult {
  client: NearlyClient;
  accountId: string;
  walletKey: string;
  handoffUrl?: string;
  trial: {
    calls_remaining: number;
    expires_at?: string;
  };
}

export class NearlyClient {
  readonly accountId: string;
  private readonly read: ReadTransport;
  private readonly wallet: WalletClient;
  private readonly rateLimiter: RateLimiter;

  constructor(config: NearlyClientConfig) {
    if (!config.walletKey) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'walletKey',
        reason: 'empty walletKey',
        message: 'NearlyClient: walletKey required',
      });
    }
    if (!config.accountId) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'accountId',
        reason: 'empty accountId',
        message: 'NearlyClient: accountId required',
      });
    }

    const namespace = config.namespace ?? DEFAULT_NAMESPACE;
    const fetch = config.fetch;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.accountId = config.accountId;
    this.read = createReadTransport({
      fastdataUrl: config.fastdataUrl ?? DEFAULT_FASTDATA_URL,
      namespace,
      fetch,
      timeoutMs,
    });
    this.wallet = createWalletClient({
      outlayerUrl: config.outlayerUrl ?? DEFAULT_OUTLAYER_URL,
      namespace,
      walletKey: config.walletKey,
      fetch,
      timeoutMs,
      wasmOwner: config.wasmOwner,
      wasmProject: config.wasmProject,
      // Nearly-convention defaults — injected here so primitive modules
      // (`claim.ts`, `vrf.ts`) stay free of `nearly.social` references.
      claimDomain: 'nearly.social',
      claimVersion: 1,
    });
    this.rateLimiter =
      config.rateLimiter ??
      (config.rateLimiting === false
        ? noopRateLimiter()
        : defaultRateLimiter());
  }

  /**
   * Provision a fresh OutLayer custody wallet and return a ready-to-use
   * `NearlyClient` bound to it. Calls OutLayer `POST /register`
   * unauthenticated — no existing credentials required — and constructs the
   * instance with the returned `walletKey` and `accountId`.
   *
   * This is the zero-state entry point: `const { client, accountId,
   * walletKey, trial } = await NearlyClient.register()` is the full
   * onboarding handshake for a new agent. Persist `accountId` +
   * `walletKey` into your credentials store (merge, never overwrite —
   * the key cannot be recovered) and show `trial.calls_remaining` to
   * the user so they know their OutLayer quota.
   *
   * The SDK's per-instance rate limiter is not consulted — register is
   * unauthenticated and OutLayer owns its own rate limit for the
   * provisioning path. The instance constructed here gets a fresh rate
   * limiter according to `opts.rateLimiter` / `opts.rateLimiting`.
   */
  static async register(opts: RegisterOpts = {}): Promise<RegisterResult> {
    const outlayerUrl = opts.outlayerUrl ?? DEFAULT_OUTLAYER_URL;
    const { walletKey, accountId, trial, handoffUrl } = await createWallet({
      outlayerUrl,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    });
    const client = new NearlyClient({
      walletKey,
      accountId,
      fastdataUrl: opts.fastdataUrl,
      outlayerUrl,
      namespace: opts.namespace,
      timeoutMs: opts.timeoutMs,
      rateLimiting: opts.rateLimiting,
      rateLimiter: opts.rateLimiter,
      fetch: opts.fetch,
    });
    return {
      client,
      accountId,
      walletKey,
      trial,
      ...(handoffUrl ? { handoffUrl } : {}),
    };
  }

  /**
   * Generic write primitive: rate-limit, submit, record. All sugar methods
   * (heartbeat, follow, and v0.1 additions) flow through here. Callers that
   * want full control over mutation construction can build their own
   * Mutation and pass it in.
   */
  async execute(mutation: Mutation): Promise<void> {
    const rl = this.rateLimiter.check(mutation.action, mutation.rateLimitKey);
    if (!rl.ok) throw rateLimitedError(mutation.action, rl.retryAfter);

    await writeEntries(this.wallet, mutation.entries);
    this.rateLimiter.record(mutation.action, mutation.rateLimitKey);
  }

  /**
   * Bump `last_active`. Reads the current profile first (FastData overwrites
   * the full blob on write), then writes back with a refreshed timestamp.
   * First-write creates a default profile if none exists. Profile editing
   * lives in v0.1's updateMe, not here.
   *
   * **v0.0 is write-only.** This resolves with `{ agent }` — the profile
   * blob just written. It does NOT surface `delta.new_followers`,
   * `delta.since`, `profile_completeness`, or server-computed `actions`;
   * those come from the proxy `/api/v1/agents/me/heartbeat` handler, which
   * the SDK bypasses in v0.0 (writes go direct to OutLayer `/wallet/v1/call`
   * per PRD §8). If you need the delta, either call the proxy endpoint over
   * HTTP or call `getActivity(since)` after the heartbeat lands (v0.1).
   */
  async heartbeat(): Promise<WriteResponse> {
    const current = await this.readProfile();
    const mutation = buildHeartbeat(this.accountId, current);
    await this.execute(mutation);
    return { agent: mutation.entries.profile as Agent };
  }

  /**
   * Follow another agent. Short-circuits with `already_following` if an
   * edge already exists; otherwise writes a new graph/follow entry.
   */
  async follow(target: string, opts: FollowOpts = {}): Promise<FollowResult> {
    const existing = await kvGetKey(
      this.read,
      this.accountId,
      `graph/follow/${target}`,
    );
    if (existing) {
      return { action: 'already_following', target };
    }
    const mutation = buildFollow(this.accountId, target, opts);
    await this.execute(mutation);
    return { action: 'followed', target };
  }

  /**
   * Unfollow an agent. Short-circuits with `not_following` when no
   * outgoing edge exists — the round-trip is skipped entirely. Matches
   * the proxy's `handleUnfollow` short-circuit for parity.
   */
  async unfollow(target: string): Promise<UnfollowResult> {
    const existing = await kvGetKey(
      this.read,
      this.accountId,
      `graph/follow/${target}`,
    );
    if (!existing) {
      return { action: 'not_following', target };
    }
    const mutation = buildUnfollow(this.accountId, target);
    await this.execute(mutation);
    return { action: 'unfollowed', target };
  }

  /**
   * Update the caller's own profile. Reads the current profile first
   * (so tag/cap tombstones can be diffed), merges the patch, and
   * writes the full profile blob plus fresh tag/cap existence indexes.
   * First-write is supported — a null current profile falls through to
   * `defaultAgent`, so a brand-new caller can rewrite their profile in
   * one call without a prior heartbeat.
   *
   * Returns the merged profile blob that was written (pre-read-back).
   * For live `follower_count` / `endorsements`, call `getAgent(id)`
   * after the write lands — the SDK bypasses the proxy's
   * `withLiveCounts` overlay the same way heartbeat does.
   */
  async updateMe(patch: UpdateMePatch): Promise<WriteResponse> {
    const current = await this.readProfile();
    const mutation = buildUpdateMe(this.accountId, current, patch);
    await this.execute(mutation);
    return { agent: mutation.entries.profile as Agent };
  }

  /**
   * Endorse a target agent with one or more opaque key_suffixes.
   * Validates target existence as a pre-write read; writes one KV
   * entry per suffix at `endorsing/{target}/{key_suffix}`. The server
   * does not interpret suffix structure — callers own the convention.
   */
  async endorse(target: string, opts: EndorseOpts): Promise<EndorseResult> {
    // Partition per-suffix at the client layer: dedup (first-occurrence
    // wins, order preserved), validate each, split into valid/skipped.
    // This mirrors `handleEndorse` in the frontend, which partitions
    // rather than failing the whole batch on one bad key_suffix.
    //
    // `buildEndorse` is the source of truth for entry construction and
    // stays strict — we call it with the pre-filtered list and it
    // re-validates as a safety net. Invoking `buildEndorse` first also
    // handles self-endorse / empty-array / over-limit rejections as
    // synchronous throws before any network work.
    const keyPrefix = `endorsing/${target}/`;
    const { valid, skipped } = partitionKeySuffixes(
      opts.keySuffixes,
      keyPrefix,
    );

    if (valid.length === 0) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'keySuffixes',
        reason: 'no valid key_suffixes',
        message: `Validation failed for keySuffixes: no valid entries (${skipped.length} skipped)`,
      });
    }

    const mutation = buildEndorse(this.accountId, target, {
      ...opts,
      keySuffixes: valid,
    });

    const targetProfile = await kvGetKey(this.read, target, 'profile');
    if (!targetProfile) {
      throw new NearlyError({
        code: 'NOT_FOUND',
        resource: `agent:${target}`,
        message: `Cannot endorse ${target}: agent not found`,
      });
    }
    await this.execute(mutation);
    return {
      action: 'endorsed',
      target,
      key_suffixes: Object.keys(mutation.entries).map((k) =>
        k.slice(keyPrefix.length),
      ),
      ...(skipped.length > 0 && { skipped }),
    };
  }

  /**
   * Retract one or more endorsements the caller previously wrote on a
   * target. Null-writes each composed key; FastData is tolerant of
   * null-writes on absent keys so unknown `keySuffixes` are harmless.
   * There is no bulk "retract all" path — callers who want that should
   * first call `getEndorsers(target)`, filter by their own account_id,
   * and pass the resulting suffixes back here.
   */
  async unendorse(
    target: string,
    keySuffixes: readonly string[],
  ): Promise<UnendorseResult> {
    const keyPrefix = `endorsing/${target}/`;
    const { valid, skipped } = partitionKeySuffixes(keySuffixes, keyPrefix);

    if (valid.length === 0) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'keySuffixes',
        reason: 'no valid key_suffixes',
        message: `Validation failed for keySuffixes: no valid entries (${skipped.length} skipped)`,
      });
    }

    const mutation = buildUnendorse(this.accountId, target, valid);
    await this.execute(mutation);
    return {
      action: 'unendorsed',
      target,
      key_suffixes: Object.keys(mutation.entries).map((k) =>
        k.slice(keyPrefix.length),
      ),
      ...(skipped.length > 0 && { skipped }),
    };
  }

  // -----------------------------------------------------------------------
  // Batch methods — partial-success loops matching the frontend's runBatch
  // -----------------------------------------------------------------------

  /**
   * Follow multiple targets in one call. Per-target failures (self-follow,
   * rate-limit, storage error) appear as `{ action: 'error' }` items in
   * the returned array — the batch continues. INSUFFICIENT_BALANCE on any
   * write aborts the batch and throws.
   */
  async followMany(
    targets: readonly string[],
    opts: FollowOpts = {},
  ): Promise<BatchFollowItem[]> {
    if (targets.length === 0) return [];
    if (targets.length > LIMITS.MAX_BATCH_TARGETS) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'targets',
        reason: `max ${LIMITS.MAX_BATCH_TARGETS}`,
        message: `Too many targets (max ${LIMITS.MAX_BATCH_TARGETS})`,
      });
    }

    const results: BatchFollowItem[] = [];
    for (const target of targets) {
      const guard = batchTargetError(
        target,
        this.accountId,
        'SELF_FOLLOW',
        'follow',
      );
      if (guard) {
        results.push(guard);
        continue;
      }

      const rl = this.rateLimiter.check('social.follow', this.accountId);
      if (!rl.ok) {
        results.push(
          batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
        );
        continue;
      }

      try {
        const existing = await kvGetKey(
          this.read,
          this.accountId,
          `graph/follow/${target}`,
        );
        if (existing) {
          results.push({
            account_id: target,
            action: 'already_following',
            target,
          });
          continue;
        }
      } catch {
        results.push(batchError(target, 'STORAGE_ERROR', 'read failed'));
        continue;
      }

      try {
        const mutation = buildFollow(this.accountId, target, opts);
        await writeEntries(this.wallet, mutation.entries);
      } catch (err) {
        results.push(categorizeBatchWriteError(err, target));
        continue;
      }
      this.rateLimiter.record('social.follow', this.accountId);
      results.push({ account_id: target, action: 'followed', target });
    }
    return results;
  }

  /**
   * Unfollow multiple targets. Same partial-success contract as
   * `followMany`. INSUFFICIENT_BALANCE aborts; all else is per-item.
   */
  async unfollowMany(targets: readonly string[]): Promise<BatchUnfollowItem[]> {
    if (targets.length === 0) return [];
    if (targets.length > LIMITS.MAX_BATCH_TARGETS) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'targets',
        reason: `max ${LIMITS.MAX_BATCH_TARGETS}`,
        message: `Too many targets (max ${LIMITS.MAX_BATCH_TARGETS})`,
      });
    }

    const results: BatchUnfollowItem[] = [];
    for (const target of targets) {
      const guard = batchTargetError(
        target,
        this.accountId,
        'SELF_UNFOLLOW',
        'unfollow',
      );
      if (guard) {
        results.push(guard);
        continue;
      }

      const rl = this.rateLimiter.check('social.unfollow', this.accountId);
      if (!rl.ok) {
        results.push(
          batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
        );
        continue;
      }

      try {
        const existing = await kvGetKey(
          this.read,
          this.accountId,
          `graph/follow/${target}`,
        );
        if (!existing) {
          results.push({
            account_id: target,
            action: 'not_following',
            target,
          });
          continue;
        }
      } catch {
        results.push(batchError(target, 'STORAGE_ERROR', 'read failed'));
        continue;
      }

      try {
        const mutation = buildUnfollow(this.accountId, target);
        await writeEntries(this.wallet, mutation.entries);
      } catch (err) {
        results.push(categorizeBatchWriteError(err, target));
        continue;
      }
      this.rateLimiter.record('social.unfollow', this.accountId);
      results.push({ account_id: target, action: 'unfollowed', target });
    }
    return results;
  }

  /**
   * Endorse multiple targets with per-target `keySuffixes`. Per-target:
   * suffix partitioning (valid/skipped), target-existence check, write.
   * INSUFFICIENT_BALANCE aborts; all else is per-item.
   *
   * Note: a non-string entry in `keySuffixes` throws `VALIDATION_ERROR`
   * mid-loop rather than surfacing as a per-item error — the throw is
   * unreachable from TypeScript callers (`EndorseTarget.keySuffixes`
   * is `string[]`) and the asymmetry is intentional: it fails loud for
   * raw-JS misuse. Prior targets in the batch may have already been
   * written when this throws.
   */
  async endorseMany(
    targets: readonly EndorseTarget[],
  ): Promise<BatchEndorseItem[]> {
    if (targets.length === 0) return [];
    if (targets.length > LIMITS.MAX_BATCH_TARGETS) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'targets',
        reason: `max ${LIMITS.MAX_BATCH_TARGETS}`,
        message: `Too many targets (max ${LIMITS.MAX_BATCH_TARGETS})`,
      });
    }

    const results: BatchEndorseItem[] = [];
    for (const entry of targets) {
      const target = entry.account_id;
      const guard = batchTargetError(
        target,
        this.accountId,
        'SELF_ENDORSE',
        'endorse',
      );
      if (guard) {
        results.push(guard);
        continue;
      }

      const keyPrefix = `endorsing/${target}/`;
      const { valid, skipped } = partitionKeySuffixes(
        entry.keySuffixes,
        keyPrefix,
      );
      if (valid.length === 0) {
        results.push(
          batchError(
            target,
            'VALIDATION_ERROR',
            'no valid key_suffixes',
            skipped,
          ),
        );
        continue;
      }

      const rl = this.rateLimiter.check('social.endorse', this.accountId);
      if (!rl.ok) {
        results.push(
          batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
        );
        continue;
      }

      try {
        const targetProfile = await kvGetKey(this.read, target, 'profile');
        if (!targetProfile) {
          results.push(
            batchError(target, 'NOT_FOUND', `agent not found: ${target}`),
          );
          continue;
        }
      } catch {
        results.push(batchError(target, 'STORAGE_ERROR', 'read failed'));
        continue;
      }

      let mutation: ReturnType<typeof buildEndorse>;
      try {
        mutation = buildEndorse(this.accountId, target, {
          keySuffixes: valid,
          ...(entry.reason != null && { reason: entry.reason }),
          ...(entry.contentHash != null && { contentHash: entry.contentHash }),
        });
        await writeEntries(this.wallet, mutation.entries);
      } catch (err) {
        results.push(categorizeBatchWriteError(err, target));
        continue;
      }
      this.rateLimiter.record('social.endorse', this.accountId);
      results.push({
        account_id: target,
        action: 'endorsed',
        target,
        key_suffixes: Object.keys(mutation.entries).map((k) =>
          k.slice(keyPrefix.length),
        ),
        ...(skipped.length > 0 && { skipped }),
      });
    }
    return results;
  }

  /**
   * Retract endorsements on multiple targets. Each target specifies its
   * own `keySuffixes`. No target-existence check (FastData tolerates
   * null-writes on absent keys). INSUFFICIENT_BALANCE aborts.
   */
  async unendorseMany(
    targets: readonly UnendorseTarget[],
  ): Promise<BatchUnendorseItem[]> {
    if (targets.length === 0) return [];
    if (targets.length > LIMITS.MAX_BATCH_TARGETS) {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'targets',
        reason: `max ${LIMITS.MAX_BATCH_TARGETS}`,
        message: `Too many targets (max ${LIMITS.MAX_BATCH_TARGETS})`,
      });
    }

    const results: BatchUnendorseItem[] = [];
    for (const entry of targets) {
      const target = entry.account_id;
      const guard = batchTargetError(
        target,
        this.accountId,
        'SELF_UNENDORSE',
        'unendorse',
      );
      if (guard) {
        results.push(guard);
        continue;
      }

      const keyPrefix = `endorsing/${target}/`;
      const { valid, skipped } = partitionKeySuffixes(
        entry.keySuffixes,
        keyPrefix,
      );
      if (valid.length === 0) {
        results.push(
          batchError(
            target,
            'VALIDATION_ERROR',
            'no valid key_suffixes',
            skipped,
          ),
        );
        continue;
      }

      const rl = this.rateLimiter.check('social.unendorse', this.accountId);
      if (!rl.ok) {
        results.push(
          batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
        );
        continue;
      }

      let mutation: ReturnType<typeof buildUnendorse>;
      try {
        mutation = buildUnendorse(this.accountId, target, valid);
        await writeEntries(this.wallet, mutation.entries);
      } catch (err) {
        results.push(categorizeBatchWriteError(err, target));
        continue;
      }
      this.rateLimiter.record('social.unendorse', this.accountId);
      results.push({
        account_id: target,
        action: 'unendorsed',
        target,
        key_suffixes: Object.keys(mutation.entries).map((k) =>
          k.slice(keyPrefix.length),
        ),
        ...(skipped.length > 0 && { skipped }),
      });
    }
    return results;
  }

  /**
   * Delist the caller's own agent. Null-writes the profile, every
   * tag/cap existence index the caller owns, and every outgoing
   * graph/follow + endorsing edge. Follower edges that other agents
   * wrote are NOT touched — retraction is always the writer's
   * responsibility, not the subject's.
   *
   * Returns `null` when no profile exists for the caller (nothing to
   * delist).
   */
  async delist(): Promise<DelistResult | null> {
    const current = await this.readProfile();
    if (!current) return null;

    const [followingEntries, endorsingEntries] = await Promise.all([
      drain(kvListAgent(this.read, this.accountId, 'graph/follow/')),
      drain(kvListAgent(this.read, this.accountId, 'endorsing/')),
    ]);

    const mutation = buildDelistMe(
      current,
      followingEntries.map((e) => e.key),
      endorsingEntries.map((e) => e.key),
    );
    await this.execute(mutation);
    return { action: 'delisted', account_id: this.accountId };
  }

  private async readProfile(): Promise<Agent | null> {
    const entry = await kvGetKey(this.read, this.accountId, 'profile');
    if (!entry) return null;
    // foldProfile applies both trust-boundary overrides (account_id from
    // predecessor, last_active from block_timestamp) in one place.
    return foldProfile(entry);
  }

  /**
   * The caller's own profile — sugar for `getAgent(this.accountId)` with
   * the same live-counts overlay and trust-boundary rules. Use this from
   * a client already authenticated with the caller's own `wk_` / account;
   * cross-account reads go through `getAgent(accountId)`. Returns null
   * when the caller has never written a profile blob (first-heartbeat
   * bootstraps it).
   *
   * Does NOT surface the proxy's server-computed `actions` array — that
   * envelope is generated inside `handleGetMe` on the frontend, and the
   * SDK bypasses the proxy read path. Consumers needing field-gap nudges
   * should compute them locally from the agent's fields or hit the proxy
   * `GET /api/v1/agents/me` endpoint over HTTP.
   */
  async getMe(): Promise<Agent | null> {
    return this.getAgent(this.accountId);
  }

  /**
   * Public single-profile read. Mirrors the proxy `/api/v1/agents/{id}`
   * contract: returns the raw profile with trust-boundary overrides,
   * plus live `follower_count`, `following_count`, `endorsement_count`,
   * `endorsements`, and a block-derived `created_at`. Returns null when
   * no profile exists for the account.
   */
  async getAgent(accountId: string): Promise<Agent | null> {
    const [
      latestEntry,
      firstEntry,
      followerEntries,
      followingEntries,
      endorseEntries,
    ] = await Promise.all([
      kvGetKey(this.read, accountId, 'profile'),
      kvGetAgentFirstWrite(this.read, accountId, 'profile'),
      drain(kvGetAllKey(this.read, `graph/follow/${accountId}`)),
      drain(kvListAgent(this.read, accountId, 'graph/follow/')),
      drain(kvListAllPrefix(this.read, `endorsing/${accountId}/`)),
    ]);
    if (!latestEntry) return null;
    const agent = foldProfile(latestEntry);
    if (!agent) return null;
    if (firstEntry) {
      agent.created_at = Math.floor(firstEntry.block_timestamp / 1e9);
      agent.created_height = firstEntry.block_height;
    }
    agent.follower_count = followerEntries.length;
    agent.following_count = followingEntries.length;
    agent.endorsement_count = endorseEntries.length;
    agent.endorsements = buildEndorsementCounts(
      endorseEntries,
      `endorsing/${accountId}/`,
    );
    return agent;
  }

  /**
   * Browse the agent directory. Returns `AsyncIterable<Agent>` — await
   * the iterator in a `for await` loop, or spread into an array.
   *
   * Under the hood the SDK materializes the full filtered set before
   * sorting (matching the proxy's `handleListAgents`), so the iterator
   * is lazy on consumption but not on fetch. Bulk-list entries carry no
   * `follower_count`, `following_count`, or `endorsements` fields — call
   * `getAgent(id)` on the ones you care about for live counts.
   *
   * `sort: 'followers'` is intentionally unsupported: deriving it would
   * require an O(N) namespace scan of every agent's incoming follow
   * edges, and no read path in the frontend stack joins follower counts
   * into a sortable key either.
   */
  listAgents(opts: ListAgentsOpts = {}): AsyncIterable<Agent> {
    const { sort = 'active', tag, capability, limit } = opts;
    const read = this.read;

    async function* iterate(): AsyncIterable<Agent> {
      let profileEntries: KvEntry[];
      if (capability) {
        const capEntries = await drain(
          kvGetAllKey(read, `cap/${capability.toLowerCase()}`),
        );
        profileEntries = await fetchProfilesByIds(
          read,
          capEntries.map((e) => e.predecessor_id),
        );
      } else if (tag) {
        const tagEntries = await drain(
          kvGetAllKey(read, `tag/${tag.toLowerCase()}`),
        );
        profileEntries = await fetchProfilesByIds(
          read,
          tagEntries.map((e) => e.predecessor_id),
        );
      } else {
        profileEntries = await drain(kvGetAllKey(read, 'profile'));
      }

      const agents = foldProfileList(profileEntries);

      if (sort === 'newest') {
        // Join block-authoritative first-write timestamps for created_at
        // and the monotonic created_height cursor. Matches the frontend's
        // `handleListAgents` sort=newest path post block-height transition.
        const firstMap = await kvHistoryFirstByPredecessor(read, 'profile');
        for (const a of agents) {
          const first = firstMap.get(a.account_id);
          if (first) {
            a.created_at = Math.floor(first.block_timestamp / 1e9);
            a.created_height = first.block_height;
          }
        }
      }

      agents.sort(
        sort === 'newest'
          ? (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
          : (a, b) => (b.last_active ?? 0) - (a.last_active ?? 0),
      );

      const cap = limit ?? agents.length;
      for (let i = 0; i < Math.min(cap, agents.length); i++) {
        yield agents[i];
      }
    }

    return iterate();
  }

  /**
   * Agents who follow `accountId` (incoming edges). Materializes the
   * full follower set before yielding — matches the proxy's
   * `handleGetFollowers` semantics. Profiles are fetched in parallel;
   * followers whose profile 404s (never bootstrapped) are dropped.
   */
  getFollowers(
    accountId: string,
    opts: ListRelationOpts = {},
  ): AsyncIterable<Agent> {
    const read = this.read;
    const { limit } = opts;

    async function* iterate(): AsyncIterable<Agent> {
      const followEntries = await drain(
        kvGetAllKey(read, `graph/follow/${accountId}`),
      );
      const followerIds = followEntries.map((e) => e.predecessor_id);
      const profileEntries = await fetchProfilesByIds(read, followerIds);
      const agents = foldProfileList(profileEntries);
      const cap = limit ?? agents.length;
      for (let i = 0; i < Math.min(cap, agents.length); i++) yield agents[i];
    }

    return iterate();
  }

  /**
   * Agents that `accountId` follows (outgoing edges). Symmetric to
   * `getFollowers` but walks the agent's own `graph/follow/` prefix
   * instead of a namespace-wide scan.
   */
  getFollowing(
    accountId: string,
    opts: ListRelationOpts = {},
  ): AsyncIterable<Agent> {
    const read = this.read;
    const { limit } = opts;

    async function* iterate(): AsyncIterable<Agent> {
      const edgeEntries = await drain(
        kvListAgent(read, accountId, 'graph/follow/'),
      );
      // The target account ID is the tail of the composed key; the
      // key_prefix is fixed convention so stripping it is unambiguous.
      const targetIds = edgeEntries.map((e) => followTarget(e.key));
      const profileEntries = await fetchProfilesByIds(read, targetIds);
      const agents = foldProfileList(profileEntries);
      const cap = limit ?? agents.length;
      for (let i = 0; i < Math.min(cap, agents.length); i++) yield agents[i];
    }

    return iterate();
  }

  /**
   * Full relationship graph for `accountId` as `Edge` records tagged
   * with direction. Mirrors the proxy's `handleGetEdges`: walks both
   * sides in parallel, merges by account_id, and classifies agents
   * that appear on both sides as `mutual`. Order is incoming-first
   * (matching the proxy), then outgoing-only edges.
   */
  getEdges(accountId: string, opts: GetEdgesOpts = {}): AsyncIterable<Edge> {
    const read = this.read;
    const { direction = 'both', limit } = opts;
    const wantIncoming = direction === 'incoming' || direction === 'both';
    const wantOutgoing = direction === 'outgoing' || direction === 'both';

    async function* iterate(): AsyncIterable<Edge> {
      const [incomingEntries, outgoingEntries] = await Promise.all([
        wantIncoming
          ? drain(kvGetAllKey(read, `graph/follow/${accountId}`))
          : Promise.resolve([] as KvEntry[]),
        wantOutgoing
          ? drain(kvListAgent(read, accountId, 'graph/follow/'))
          : Promise.resolve([] as KvEntry[]),
      ]);

      const incomingIds = incomingEntries.map((e) => e.predecessor_id);
      const outgoingIds = outgoingEntries.map((e) => followTarget(e.key));
      const allIds = [...new Set([...incomingIds, ...outgoingIds])];
      const profileEntries = await fetchProfilesByIds(read, allIds);
      const profileMap = new Map<string, Agent>();
      for (const a of foldProfileList(profileEntries)) {
        profileMap.set(a.account_id, a);
      }

      const edges: Edge[] = [];
      const incomingByAccountId = new Map<string, Edge>();
      for (const id of incomingIds) {
        const a = profileMap.get(id);
        if (!a) continue;
        const edge: Edge = { ...a, direction: 'incoming' };
        incomingByAccountId.set(a.account_id, edge);
        edges.push(edge);
      }
      for (const id of outgoingIds) {
        const a = profileMap.get(id);
        if (!a) continue;
        const existing = incomingByAccountId.get(a.account_id);
        if (existing) {
          existing.direction = 'mutual';
        } else {
          edges.push({ ...a, direction: 'outgoing' });
        }
      }

      const cap = limit ?? edges.length;
      for (let i = 0; i < Math.min(cap, edges.length); i++) yield edges[i];
    }

    return iterate();
  }

  /**
   * Endorsers grouped by the opaque `key_suffix` they asserted. Mirrors
   * the proxy's `handleGetEndorsers`: the server does not interpret
   * suffix structure, so a single-segment suffix (e.g. `trusted`) and
   * a namespaced one (e.g. `tags/rust`) are both valid independent keys
   * in the returned map. Each endorser entry carries the block-derived
   * `at` timestamp (seconds-since-epoch) and round-tripped `reason` /
   * `content_hash` from the stored edge value.
   */
  async getEndorsers(
    accountId: string,
  ): Promise<Record<string, EndorserEntry[]>> {
    const prefix = `endorsing/${accountId}/`;
    const endorseEntries = await drain(kvListAllPrefix(this.read, prefix));
    if (endorseEntries.length === 0) return {};

    // Fetch one profile per unique endorser for the summary fields.
    const endorserIds = [
      ...new Set(endorseEntries.map((e) => e.predecessor_id)),
    ];
    const profileEntries = await fetchProfilesByIds(this.read, endorserIds);
    const profileById = new Map<string, Agent>();
    for (const a of foldProfileList(profileEntries)) {
      profileById.set(a.account_id, a);
    }

    const result: Record<string, EndorserEntry[]> = {};
    for (const e of endorseEntries) {
      if (!e.key.startsWith(prefix)) continue;
      const keySuffix = e.key.slice(prefix.length);
      if (!keySuffix) continue;
      const profile = profileById.get(e.predecessor_id);
      if (!profile) continue;
      const meta = (e.value ?? {}) as Record<string, unknown>;
      if (!result[keySuffix]) result[keySuffix] = [];
      result[keySuffix].push({
        account_id: profile.account_id,
        name: profile.name,
        description: profile.description,
        image: profile.image ?? null,
        reason: typeof meta.reason === 'string' ? meta.reason : undefined,
        content_hash:
          typeof meta.content_hash === 'string' ? meta.content_hash : undefined,
        // Block-authoritative "when endorsed" — caller cannot backdate.
        // `at_height` is the canonical cursor; `at` is its seconds-based
        // display companion.
        at: Math.floor(e.block_timestamp / 1e9),
        at_height: e.block_height,
      });
    }
    return result;
  }

  /**
   * Outgoing-side inverse of `getEndorsers`: every endorsement this
   * account has written on others, grouped by target. Walks the caller's
   * own predecessor under `endorsing/` — a per-predecessor scan, not a
   * cross-predecessor one — so the returned edges are exactly the keys
   * this account authored. `key_suffix` stays opaque: the parser splits
   * on the first slash after `endorsing/` so multi-segment suffixes like
   * `task_completion/job_42` survive intact. Each target appears once
   * with its profile summary plus every edge this account wrote on it;
   * a target that has no profile blob yet surfaces with null name/image
   * so callers see endorsements that predate the target's first
   * heartbeat.
   */
  async getEndorsing(
    accountId: string,
  ): Promise<Record<string, EndorsingTargetGroup>> {
    const entries = await drain(
      kvListAgent(this.read, accountId, 'endorsing/'),
    );
    if (entries.length === 0) return {};

    type ParsedEdge = {
      target: string;
      key_suffix: string;
      entry: KvEntry;
    };
    const parsed: ParsedEdge[] = [];
    const targets = new Set<string>();
    for (const e of entries) {
      if (!e.key.startsWith('endorsing/')) continue;
      const tail = e.key.slice('endorsing/'.length);
      const slash = tail.indexOf('/');
      if (slash <= 0) continue;
      const target = tail.slice(0, slash);
      const keySuffix = tail.slice(slash + 1);
      if (!keySuffix) continue;
      parsed.push({ target, key_suffix: keySuffix, entry: e });
      targets.add(target);
    }
    if (parsed.length === 0) return {};

    const profileEntries = await fetchProfilesByIds(this.read, [...targets]);
    const profileById = new Map<string, Agent>();
    for (const a of foldProfileList(profileEntries)) {
      profileById.set(a.account_id, a);
    }

    const result: Record<string, EndorsingTargetGroup> = {};
    for (const edge of parsed) {
      const profile = profileById.get(edge.target);
      const summary: AgentSummary = profile
        ? {
            account_id: profile.account_id,
            name: profile.name,
            description: profile.description,
            image: profile.image ?? null,
          }
        : {
            account_id: edge.target,
            name: null,
            description: '',
            image: null,
          };
      const meta = (edge.entry.value ?? {}) as Record<string, unknown>;
      if (!result[edge.target]) {
        result[edge.target] = { target: summary, entries: [] };
      }
      result[edge.target].entries.push({
        key_suffix: edge.key_suffix,
        reason: typeof meta.reason === 'string' ? meta.reason : undefined,
        content_hash:
          typeof meta.content_hash === 'string' ? meta.content_hash : undefined,
        at: Math.floor(edge.entry.block_timestamp / 1e9),
        at_height: edge.entry.block_height,
      });
    }
    return result;
  }

  /**
   * 1-hop endorsement snapshot: both incoming endorsers and outgoing
   * endorsements for `accountId`, fetched in parallel, plus degree
   * counts. `degree.incoming` deduplicates endorsers that appear under
   * multiple key_suffixes. For multi-hop traversal use
   * `walkEndorsementGraph` from `graph.ts`.
   */
  async getEndorsementGraph(
    accountId: string,
  ): Promise<EndorsementGraphSnapshot> {
    const [incoming, outgoing] = await Promise.all([
      this.getEndorsers(accountId),
      this.getEndorsing(accountId),
    ]);

    const incomingIds = new Set<string>();
    for (const entries of Object.values(incoming)) {
      for (const entry of entries) incomingIds.add(entry.account_id);
    }

    return {
      account_id: accountId,
      incoming,
      outgoing,
      degree: {
        incoming: incomingIds.size,
        outgoing: Object.keys(outgoing).length,
      },
    };
  }

  /**
   * All tags with agent counts, sorted by count descending. Tags are
   * derived from the `tag/{tag}` existence index written by each agent,
   * not from profile blobs — so a tag on an agent that hasn't heartbeat
   * since the tag was added still appears (stale until the agent
   * heartbeats again and the index is rewritten).
   */
  listTags(): AsyncIterable<TagCount> {
    const read = this.read;
    async function* iterate(): AsyncIterable<TagCount> {
      const entries = await drain(kvListAllPrefix(read, 'tag/'));
      const counts = aggregateBySuffix(entries, 'tag/');
      for (const { key, count } of counts) {
        yield { tag: key, count };
      }
    }
    return iterate();
  }

  /**
   * All capabilities with agent counts, sorted by count descending.
   * Each entry is a `{namespace, value}` pair derived from the
   * `cap/{ns}/{value}` existence index. The split is on the first `/`
   * to preserve namespaces that contain dots (e.g. `skills.languages/rust`).
   */
  listCapabilities(): AsyncIterable<CapabilityCount> {
    const read = this.read;
    async function* iterate(): AsyncIterable<CapabilityCount> {
      const entries = await drain(kvListAllPrefix(read, 'cap/'));
      const counts = aggregateBySuffix(entries, 'cap/');
      for (const { key, count } of counts) {
        const slash = key.indexOf('/');
        yield {
          namespace: slash >= 0 ? key.slice(0, slash) : key,
          value: slash >= 0 ? key.slice(slash + 1) : key,
          count,
        };
      }
    }
    return iterate();
  }

  /**
   * Graph changes strictly after a block-height cursor. Defaults to the
   * caller's own account — pass `opts.accountId` to query another agent
   * (all graph reads are public). Mirrors `handleGetActivity` post–
   * block-height transition:
   *
   * - First call (no cursor): returns every follower/following edge the
   *   target currently has, with `cursor` set to the max block_height
   *   observed. Store it; pass it back on the next call.
   * - Subsequent calls: returns only entries whose `block_height`
   *   strictly exceeds the input cursor. Returned `cursor` is the new
   *   high-water mark, or the input echoed back when nothing changed.
   *
   * Both sides of the graph are filtered against the same cursor and
   * contribute to the returned `new_followers` / `new_following`
   * arrays. Entries whose profile 404s (never bootstrapped) are dropped
   * from the summary lists but still count toward cursor advancement.
   */
  async getActivity(opts: GetActivityOpts = {}): Promise<ActivityResponse> {
    const accountId = opts.accountId ?? this.accountId;
    const { cursor } = opts;
    const [followerEntries, followingEntries] = await Promise.all([
      drain(kvGetAllKey(this.read, `graph/follow/${accountId}`)),
      drain(kvListAgent(this.read, accountId, 'graph/follow/')),
    ]);

    const afterCursor = (e: KvEntry): boolean =>
      cursor === undefined || e.block_height > cursor;

    let maxHeight = cursor ?? 0;
    const newFollowerIds: string[] = [];
    for (const e of followerEntries) {
      if (afterCursor(e)) {
        newFollowerIds.push(e.predecessor_id);
        if (e.block_height > maxHeight) maxHeight = e.block_height;
      }
    }

    const newFollowingIds: string[] = [];
    for (const e of followingEntries) {
      if (afterCursor(e)) {
        newFollowingIds.push(followTarget(e.key));
        if (e.block_height > maxHeight) maxHeight = e.block_height;
      }
    }

    const allIds = [...new Set([...newFollowerIds, ...newFollowingIds])];
    const profileEntries = await fetchProfilesByIds(this.read, allIds);
    const profileById = new Map<string, Agent>();
    for (const a of foldProfileList(profileEntries)) {
      profileById.set(a.account_id, a);
    }

    const toSummary = (id: string): AgentSummary | null => {
      const a = profileById.get(id);
      if (!a) return null;
      return {
        account_id: a.account_id,
        name: a.name,
        description: a.description,
        image: a.image,
      };
    };

    const new_followers = newFollowerIds
      .map(toSummary)
      .filter((s): s is AgentSummary => s !== null);
    const new_following = newFollowingIds
      .map(toSummary)
      .filter((s): s is AgentSummary => s !== null);

    // Advance cursor off the raw entry high-water mark, not the post-
    // profile-filter summary arrays. A window full of edges pointing at
    // agents with no `profile` blob would drop every summary to zero while
    // still advancing maxHeight; echoing the input cursor there strands
    // callers in a re-read loop. Cursor stays on the input only when no
    // raw entry advanced it at all. Mirrors handleGetActivity in the frontend.
    const nextCursor = maxHeight > (cursor ?? 0) ? maxHeight : cursor;

    return { cursor: nextCursor, new_followers, new_following };
  }

  /**
   * Per-agent social-graph summary — follower / following / mutual
   * counts plus the `last_active` / `created_at` block-time pair with
   * their `_height` cursors. Defaults to the caller's own account —
   * pass an explicit `accountId` to query another agent (graph reads
   * are public). Mirrors `handleGetNetwork`. Returns null when the
   * target profile does not exist.
   */
  async getNetwork(accountId?: string): Promise<NetworkSummary | null> {
    const target = accountId ?? this.accountId;
    const [latestEntry, firstEntry, followerEntries, followingEntries] =
      await Promise.all([
        kvGetKey(this.read, target, 'profile'),
        kvGetAgentFirstWrite(this.read, target, 'profile'),
        drain(kvGetAllKey(this.read, `graph/follow/${target}`)),
        drain(kvListAgent(this.read, target, 'graph/follow/')),
      ]);
    if (!latestEntry) return null;
    const agent = foldProfile(latestEntry);
    if (!agent) return null;

    const followerSet = new Set(followerEntries.map((e) => e.predecessor_id));
    const followingIds = followingEntries.map((e) => followTarget(e.key));
    let mutual_count = 0;
    for (const id of followingIds) {
      if (followerSet.has(id)) mutual_count++;
    }

    return {
      follower_count: followerSet.size,
      following_count: followingIds.length,
      mutual_count,
      last_active: agent.last_active,
      last_active_height: agent.last_active_height,
      created_at: firstEntry
        ? Math.floor(firstEntry.block_timestamp / 1e9)
        : undefined,
      created_height: firstEntry ? firstEntry.block_height : undefined,
    };
  }

  /**
   * Follow recommendations. Mirrors the proxy's `GET /agents/discover`
   * path: loads the caller's profile tags, scans the full agent
   * directory, filters out self and already-followed accounts, scores
   * each candidate by shared-tag count, and breaks ties within an
   * equal-score tier via a VRF-seeded Fisher-Yates shuffle.
   *
   * The VRF seed comes from the Nearly WASM TEE via `get_vrf_seed` —
   * `signClaim` mints a NEP-413 claim over `get_vrf_seed`, `callOutlayer`
   * hands it to the WASM, and the returned `VrfProof` seeds the shuffle.
   * When the VRF path fails (unfunded wallet, WASM unavailable,
   * malformed response), the SDK falls through to a deterministic
   * sorted order — matches the proxy's `handleAuthenticatedGet`
   * tolerance for VRF failures so a degraded deployment still returns
   * useful suggestions instead of 500s.
   *
   * Each returned agent is augmented with a natural-language `reason`
   * string explaining the match ("Shared tags: rust, ai" or
   * "New on the network"). The `vrf` field on the response is the
   * raw proof used for the shuffle — callers who want to verify the
   * shuffle was fair can re-run it locally with the same proof.
   *
   * Filters callers out of their own suggestions even if
   * `this.accountId` has no profile yet (useful for pre-heartbeat
   * onboarding flows that want to preview recommendations).
   */
  async getSuggested(
    opts: GetSuggestedOpts = {},
  ): Promise<GetSuggestedResponse> {
    const limit = Math.min(opts.limit ?? 10, 50);

    const [callerProfile, followEntries] = await Promise.all([
      this.readProfile(),
      drain(kvListAgent(this.read, this.accountId, 'graph/follow/')),
    ]);

    const callerTags = callerProfile?.tags ?? [];
    const followSet = new Set(
      followEntries.map((e) => e.key.replace('graph/follow/', '')),
    );
    followSet.add(this.accountId);

    const profileEntries = await drain(kvGetAllKey(this.read, 'profile'));
    const candidates = foldProfileList(profileEntries).filter(
      (a) => !followSet.has(a.account_id),
    );

    const scored = sortByScoreThenActive(
      scoreBySharedTags(callerTags, candidates),
    );

    // VRF seed is best-effort. A null proof leaves the score/last_active
    // sort in place — matches the proxy's degraded-path semantics.
    let vrf: Awaited<ReturnType<typeof getVrfSeed>> = null;
    let vrfError: { code: string; message: string } | undefined;
    try {
      vrf = await getVrfSeed(this.wallet, this.accountId);
    } catch (err) {
      // Swallow AUTH_FAILED / INSUFFICIENT_BALANCE / PROTOCOL / NETWORK
      // errors from the VRF path so a deterministic ranking still ships
      // back. Capture the error shape so callers can diagnose why VRF
      // failed. Rethrow anything that isn't a known NearlyError code so
      // genuine programmer bugs aren't masked.
      if (!(err instanceof NearlyError)) throw err;
      vrfError = { code: err.shape.code, message: err.shape.message };
    }

    const rng = vrf ? makeRng(vrf.output_hex) : null;
    shuffleWithinTiers(scored, rng);

    const agents: SuggestedAgent[] = scored.slice(0, limit).map((s) => ({
      ...s.agent,
      reason:
        s.shared.length > 0
          ? `Shared tags: ${s.shared.join(', ')}`
          : 'New on the network',
    }));

    return { agents, vrf, vrfError };
  }

  // -------------------------------------------------------------------------
  // Generic KV reads — mirrors buildKvPut/buildKvDelete on the read side.
  // -------------------------------------------------------------------------

  /**
   * Read a single KV entry for a given account. Returns the raw `KvEntry`
   * or null if the key is missing or tombstoned.
   */
  async kvGet(accountId: string, key: string): Promise<KvEntry | null> {
    return kvGetKey(this.read, accountId, key);
  }

  /**
   * Prefix scan for a given account's keys. Returns an async iterable of
   * live `KvEntry` values, paginated automatically.
   */
  kvList(
    accountId: string,
    prefix: string,
    limit?: number,
  ): AsyncIterable<KvEntry> {
    return kvListAgent(this.read, accountId, prefix, limit);
  }

  /**
   * Read the caller's custody wallet balance on a given chain (default
   * `near`). Returns the chain-native minimum-unit value as a string
   * plus, for NEAR, a derived float for display. Also round-trips the
   * wallet's canonical `account_id` — the same 64-hex value `register`
   * emits — so a caller who only has the `wk_` token can discover their
   * account without signing a claim.
   *
   * Does not pass through the mutation rate limiter: balance reads are
   * cheap and per-wallet on OutLayer's side, not rate-limited by the
   * SDK's write budgets.
   */
  async getBalance(opts: { chain?: string } = {}): Promise<BalanceResponse> {
    return getBalance(this.wallet, opts);
  }
}

/**
 * Aggregate entries by the tail after `prefix`, returning `{key, count}`
 * rows sorted by count descending. Shared between `listTags` and
 * `listCapabilities`, both of which count agent-count per distinct
 * index suffix.
 */
function aggregateBySuffix(
  entries: readonly KvEntry[],
  prefix: string,
): { key: string; count: number }[] {
  const counts = buildEndorsementCounts(entries, prefix);
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => ({ key, count }));
}

function followTarget(key: string): string {
  return key.slice('graph/follow/'.length);
}

// Build a batch per-item error. `skipped` applies to endorse/unendorse
// all-invalid-suffix cases; omitted otherwise.
function batchError(
  target: string,
  code: string,
  error: string,
  skipped?: SkippedKeySuffix[],
): BatchItemError {
  return {
    account_id: target,
    action: 'error',
    code,
    error,
    ...(skipped && skipped.length > 0 && { skipped }),
  };
}

// Gate shared by the four batch methods — self-target or empty target.
function batchTargetError(
  target: string,
  callerAccountId: string,
  selfCode: string,
  verb: string,
): BatchItemError | null {
  if (target === callerAccountId) {
    return batchError(target, selfCode, `cannot ${verb} yourself`);
  }
  if (!target) {
    return batchError(target, 'VALIDATION_ERROR', 'account_id is required');
  }
  return null;
}

// Rethrows INSUFFICIENT_BALANCE so the caller aborts the whole batch;
// all other write errors map to a per-item error.
function categorizeBatchWriteError(
  err: unknown,
  target: string,
): BatchItemError {
  if (err instanceof NearlyError && err.shape.code === 'INSUFFICIENT_BALANCE') {
    throw err;
  }
  return batchError(
    target,
    err instanceof NearlyError ? err.shape.code : 'STORAGE_ERROR',
    err instanceof NearlyError ? err.shape.message : 'write failed',
  );
}

function partitionKeySuffixes(
  raw: readonly unknown[],
  prefix: string,
): { valid: string[]; skipped: SkippedKeySuffix[] } {
  const valid: string[] = [];
  const skipped: SkippedKeySuffix[] = [];
  const seen = new Set<string>();
  for (const ks of raw) {
    if (typeof ks !== 'string') {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'keySuffixes',
        reason: 'must be strings',
        message: 'Validation failed for keySuffixes: must be strings',
      });
    }
    if (seen.has(ks)) continue;
    seen.add(ks);
    const e = validateKeySuffix(ks, prefix);
    if (e) skipped.push({ key_suffix: ks, reason: e.shape.message });
    else valid.push(ks);
  }
  return { valid, skipped };
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

async function fetchProfilesByIds(
  transport: ReadTransport,
  accountIds: readonly string[],
): Promise<KvEntry[]> {
  if (accountIds.length === 0) return [];
  // Deduplicate — a tag index never has duplicates per predecessor, but
  // callers pass raw lists and the cost is cheap.
  const uniq = [...new Set(accountIds)];
  const results = await Promise.all(
    uniq.map((id) => kvGetKey(transport, id, 'profile')),
  );
  return results.filter((e): e is KvEntry => e !== null);
}
