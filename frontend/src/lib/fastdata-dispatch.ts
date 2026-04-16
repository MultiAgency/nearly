/**
 * Dispatch read actions via FastData KV.
 *
 * Per-predecessor model: each agent's data is stored under their NEAR account.
 * Key schema:
 *   profile              → AgentRecord
 *   tag/{tag}            → true (existence index)
 *   cap/{ns}/{value}     → true (existence index)
 *   graph/follow/{accountId} → {reason?}   (time is FastData block_timestamp)
 */

import {
  makeRng,
  scoreBySharedTags,
  shuffleWithinTiers,
  sortByScoreThenActive,
} from '@nearly/sdk';
import type { Agent, VrfProof } from '@/types';
import {
  type KvEntry,
  kvGetAgent,
  kvGetAll,
  kvHistoryFirstByPredecessor,
  kvListAgent,
  kvListAll,
} from './fastdata';
import {
  buildEndorsementCounts,
  endorsePrefix,
  entryBlockHeight,
  entryBlockSecs,
  fetchAllProfiles,
  fetchProfile,
  fetchProfiles,
  liveNetworkCounts,
  profileCompleteness,
  profileSummary,
} from './fastdata-utils';
export type FastDataError = { error: string; status?: number };
type FastDataResult = { data: unknown } | FastDataError;

async function requireAgent(
  body: Record<string, unknown>,
): Promise<{ accountId: string } | FastDataError> {
  const accountId = body.account_id as string | undefined;
  if (!accountId) return { error: 'account_id is required', status: 400 };
  return { accountId };
}

function cursorPaginate<T>(
  items: T[],
  cursor: string | undefined,
  limit: number,
  getKey: (t: T) => string,
): { page: T[]; nextCursor?: string; cursorReset?: boolean } {
  let startIdx = 0;
  let cursorReset: boolean | undefined;
  if (cursor) {
    const idx = items.findIndex((t) => getKey(t) === cursor);
    if (idx >= 0) {
      startIdx = idx + 1;
    } else {
      cursorReset = true;
    }
  }
  const slice = items.slice(startIdx, startIdx + limit + 1);
  const hasMore = slice.length > limit;
  return {
    page: slice.slice(0, limit),
    nextCursor: hasMore ? getKey(slice[limit - 1]) : undefined,
    cursorReset,
  };
}

export async function dispatchFastData(
  action: string,
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  try {
    switch (action) {
      case 'health':
        return { data: await handleHealth() };
      case 'profile':
        return await handleGetProfile(body);
      case 'list_tags':
        return { data: await handleListTags() };
      case 'list_capabilities':
        return { data: await handleListCapabilities() };
      case 'list_agents':
        return await handleListAgents(body);
      case 'followers':
        return await handleGetFollowers(body);
      case 'following':
        return await handleGetFollowing(body);
      case 'me':
        return await handleGetMe(body);
      case 'discover_agents':
        return await handleGetSuggested(body, null);
      case 'edges':
        return await handleGetEdges(body);
      case 'endorsers':
        return await handleGetEndorsers(body);
      case 'endorsing':
        return await handleGetEndorsing(body);
      case 'activity':
        return await handleGetActivity(body);
      case 'network':
        return await handleGetNetwork(body);
      default:
        return { error: `Unsupported action: ${action}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `FastData KV error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Public read handlers
// ---------------------------------------------------------------------------

async function handleHealth(): Promise<unknown> {
  const entries = await kvGetAll('profile');
  return { agent_count: entries.length, status: 'ok' };
}

/** Overlay live counts (endorsements, followers, following) onto a raw profile. */
async function withLiveCounts(accountId: string, raw: Agent): Promise<Agent> {
  const [counts, endorseEntries] = await Promise.all([
    liveNetworkCounts(accountId),
    kvListAll(endorsePrefix(accountId)),
  ]);
  return {
    ...raw,
    endorsements: buildEndorsementCounts(endorseEntries, accountId),
    endorsement_count: endorseEntries.length,
    ...counts,
  };
}

async function handleGetProfile(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const callerAccountId = body.caller_account_id as string | undefined;
  const [raw, callerContext] = await Promise.all([
    fetchProfile(accountId),
    // Caller enrichment is best-effort: if the KV lookups fail transiently,
    // fall back to an unenriched profile rather than failing the whole read.
    callerAccountId
      ? fetchCallerContext(callerAccountId, accountId).catch((err) => {
          console.error(
            '[fastdata-dispatch] caller context fetch failed:',
            err instanceof Error ? err.message : String(err),
          );
          return null;
        })
      : Promise.resolve(null),
  ]);
  if (!raw) return { error: 'Agent not found', status: 404 };

  return {
    data: {
      agent: await withLiveCounts(accountId, raw),
      ...(callerContext ?? {}),
    },
  };
}

async function fetchCallerContext(
  callerAccountId: string,
  targetAccountId: string,
): Promise<{
  is_following: boolean;
  my_endorsements: string[];
}> {
  const [followEntry, endorseEntries] = await Promise.all([
    kvGetAgent(callerAccountId, `graph/follow/${targetAccountId}`),
    kvListAgent(callerAccountId, `endorsing/${targetAccountId}/`),
  ]);
  const prefix = `endorsing/${targetAccountId}/`;
  const my_endorsements: string[] = [];
  for (const e of endorseEntries) {
    if (!e.key.startsWith(prefix)) continue;
    my_endorsements.push(e.key.slice(prefix.length));
  }
  return { is_following: followEntry !== null, my_endorsements };
}

/** Scan KV entries by prefix and aggregate counts by key suffix, sorted desc. */
async function aggregateCounts(
  prefix: string,
): Promise<{ key: string; count: number }[]> {
  const entries = await kvListAll(prefix);
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const key = e.key.replace(prefix, '');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => ({ key, count }));
}

async function handleListTags(): Promise<unknown> {
  const rows = await aggregateCounts('tag/');
  return { tags: rows.map(({ key, count }) => ({ tag: key, count })) };
}

async function handleListCapabilities(): Promise<unknown> {
  const rows = await aggregateCounts('cap/');
  return {
    capabilities: rows.map(({ key, count }) => {
      const slash = key.indexOf('/');
      return {
        namespace: slash >= 0 ? key.slice(0, slash) : key,
        value: slash >= 0 ? key.slice(slash + 1) : key,
        count,
      };
    }),
  };
}

async function handleListAgents(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const sort = (body.sort as string) || 'active';
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;
  const tag = body.tag as string | undefined;
  const capability = body.capability as string | undefined;

  // `sort=newest` needs a namespace-wide history walk to derive each
  // agent's first-write `created_at`; `sort=active` doesn't, because
  // `last_active` is already block-authoritative on the latest read.
  const [allAgents, firstSeenMap] = await Promise.all([
    capability || tag
      ? kvGetAll(
          capability
            ? `cap/${capability.toLowerCase()}`
            : `tag/${tag!.toLowerCase()}`,
        ).then((entries) => fetchProfiles(entries.map((e) => e.predecessor_id)))
      : fetchAllProfiles(),
    sort === 'newest'
      ? kvHistoryFirstByPredecessor('profile')
      : Promise.resolve(null),
  ]);

  if (firstSeenMap) {
    for (const a of allAgents) {
      const firstEntry = firstSeenMap.get(a.account_id);
      if (firstEntry) {
        a.created_at = entryBlockSecs(firstEntry);
        a.created_height = entryBlockHeight(firstEntry);
      }
    }
  }

  // Backend returns raw graph truth. Counts are live per-profile via
  // `withLiveCounts` — not overlaid on bulk lists. The frontend owns
  // hidden-set suppression via `useHiddenSet` at render time.
  const sortFn = sortComparator(sort);
  allAgents.sort(sortFn);

  const { page, nextCursor, cursorReset } = cursorPaginate(
    allAgents,
    cursor,
    limit,
    (a) => a.account_id,
  );

  return {
    data: {
      agents: page,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

/**
 * Both sort modes derive from FastData block history and are
 * ungameable by caller-asserted values. Agents missing a `created_at`
 * (history call failed, or the entry was indexed too recently to be
 * retrievable) sort last under `sort=newest` — treat undefined as 0
 * to keep the comparator total.
 */
function sortComparator(sort: string): (a: Agent, b: Agent) => number {
  switch (sort) {
    case 'newest':
      return (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0);
    default: // 'active'
      return (a, b) => (b.last_active ?? 0) - (a.last_active ?? 0);
  }
}

async function handleGetFollowers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  // "Who follows accountId?" = all predecessors who wrote graph/follow/{accountId}
  const entries = await kvGetAll(`graph/follow/${accountId}`);
  const followerAccounts = entries.map((e) => e.predecessor_id);

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followerAccounts,
    cursor,
    limit,
    (a) => a,
  );

  const agents = await fetchProfiles(page);

  return {
    data: {
      account_id: accountId,
      followers: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

async function handleGetFollowing(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  // "Who does accountId follow?" = agent's graph/follow/* keys
  const entries = await kvListAgent(accountId, 'graph/follow/');
  const followedAccountIds = entries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followedAccountIds,
    cursor,
    limit,
    (a) => a,
  );

  const agents = await fetchProfiles(page);

  return {
    data: {
      account_id: accountId,
      following: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

// ---------------------------------------------------------------------------
// Authenticated read handlers
// ---------------------------------------------------------------------------

async function handleGetMe(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const raw = await fetchProfile(accountId);
  if (!raw) return { error: 'Agent not found', status: 404 };

  const agent = await withLiveCounts(accountId, raw);

  return {
    data: {
      agent,
      profile_completeness: profileCompleteness(agent),
    },
  };
}

// ---------------------------------------------------------------------------
// VRF-seeded suggestion ranking
// ---------------------------------------------------------------------------

export async function handleGetSuggested(
  body: Record<string, unknown>,
  vrfProof: VrfProof | null,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 10, 50);

  const [callerAgent, followEntries] = await Promise.all([
    fetchProfile(accountId),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  const followSet = new Set(
    followEntries.map((e) => e.key.replace('graph/follow/', '')),
  );
  followSet.add(accountId);

  const allAgents = await fetchAllProfiles();
  const candidates = allAgents.filter((a) => !followSet.has(a.account_id));

  // Rank via the SDK's pure suggest helpers — single source of truth for
  // scoring, tie-breaking, and VRF-seeded fair shuffle within equal-score
  // tiers. A null vrfProof leaves the sort-by-last_active fallback in place.
  const scored = sortByScoreThenActive(
    scoreBySharedTags(callerAgent?.tags ?? [], candidates),
  );
  shuffleWithinTiers(scored, vrfProof ? makeRng(vrfProof.output_hex) : null);

  const agents = scored.slice(0, limit).map((s) => {
    const reason =
      s.shared.length > 0
        ? `Shared tags: ${s.shared.join(', ')}`
        : 'New on the network';
    return {
      ...s.agent,
      reason,
    };
  });

  return { data: { agents, vrf: vrfProof } };
}

// ---------------------------------------------------------------------------
// Edge & endorser handlers
// ---------------------------------------------------------------------------

async function handleGetEdges(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const direction = (body.direction as string) || 'both';

  const wantIncoming = direction === 'incoming' || direction === 'both';
  const wantOutgoing = direction === 'outgoing' || direction === 'both';

  const [incomingEntries, outgoingEntries] = await Promise.all([
    wantIncoming ? kvGetAll(`graph/follow/${accountId}`) : Promise.resolve([]),
    wantOutgoing
      ? kvListAgent(accountId, 'graph/follow/')
      : Promise.resolve([]),
  ]);

  // Collect all account IDs needed, dedupe, single batch fetch.
  const incomingAccountIds = incomingEntries.map((e) => e.predecessor_id);
  const outgoingAccountIds = outgoingEntries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );
  const allAccountIds = [
    ...new Set([...incomingAccountIds, ...outgoingAccountIds]),
  ];
  // Edges are identity views — no count overlay.
  const profileMap = new Map<string, Agent>();
  for (const a of await fetchProfiles(allAccountIds)) {
    profileMap.set(a.account_id, a);
  }

  const edges: Record<string, unknown>[] = [];
  const incomingByAccountId = new Map<string, Record<string, unknown>>();

  for (const id of incomingAccountIds) {
    const a = profileMap.get(id);
    if (!a) continue;
    const edge = { ...a, direction: 'incoming' };
    incomingByAccountId.set(a.account_id, edge);
    edges.push(edge);
  }

  for (const id of outgoingAccountIds) {
    const a = profileMap.get(id);
    if (!a) continue;
    const existing = incomingByAccountId.get(a.account_id);
    if (existing) {
      existing.direction = 'mutual';
    } else {
      edges.push({ ...a, direction: 'outgoing' });
    }
  }

  return {
    data: {
      account_id: accountId,
      edges: edges.slice(0, limit),
    },
  };
}

async function handleGetEndorsers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const prefix = endorsePrefix(accountId);
  const endorseEntries = await kvListAll(prefix);

  const endorserAccountIds = [
    ...new Set(endorseEntries.map((e) => e.predecessor_id)),
  ];
  const profileMap = new Map<string, ReturnType<typeof profileSummary>>();
  for (const p of await fetchProfiles(endorserAccountIds)) {
    profileMap.set(p.account_id, profileSummary(p));
  }

  // Group entries by opaque key_suffix. The tail after `endorsing/{target}/`
  // is passed through unchanged — the server does not interpret segments.
  const endorsers: Record<
    string,
    Array<{
      account_id: string;
      name: string | null;
      description: string;
      image: string | null;
      reason?: string;
      content_hash?: string;
      at?: number;
      at_height?: number;
    }>
  > = {};

  for (const e of endorseEntries) {
    if (!e.key.startsWith(prefix)) continue;
    const keySuffix = e.key.slice(prefix.length);
    if (!keySuffix) continue;

    const profile = profileMap.get(e.predecessor_id);
    if (!profile) continue;

    const meta = (e.value ?? {}) as Record<string, unknown>;

    if (!endorsers[keySuffix]) endorsers[keySuffix] = [];
    endorsers[keySuffix].push({
      account_id: profile.account_id,
      name: profile.name,
      description: profile.description,
      image: profile.image ?? null,
      reason: meta.reason as string | undefined,
      content_hash: meta.content_hash as string | undefined,
      // Block-authoritative — endorsers cannot backdate or forward-date
      // by lying in the value blob. `at_height` is the canonical "when";
      // `at` is emitted alongside for consumers not yet on `at_height`.
      at: entryBlockSecs(e),
      at_height: entryBlockHeight(e),
    });
  }

  return {
    data: {
      account_id: accountId,
      endorsers,
    },
  };
}

/**
 * Targets with no profile blob surface with a null-fielded summary —
 * endorsements can exist before the target ever heartbeats, and the
 * envelope is the authoritative record.
 *
 * No cross-predecessor filter is needed: `kvListAgent(accountId, ...)`
 * already scopes the scan to keys the caller wrote under their own
 * namespace, so the endorser's identity is implicit in the query.
 */
async function handleGetEndorsing(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const entries = await kvListAgent(accountId, 'endorsing/');
  if (entries.length === 0) {
    return { data: { account_id: accountId, endorsing: {} } };
  }

  // Parse `endorsing/{target}/{key_suffix}` keys. Split on the FIRST
  // slash after the `endorsing/` prefix so suffixes that themselves
  // contain slashes (e.g. `tags/rust`, `task_completion/job_42`)
  // survive verbatim. A bare `endorsing/bob.near/` with no suffix is
  // dropped — the server does not store or surface empty suffixes.
  type ParsedEdge = {
    target: string;
    key_suffix: string;
    value: Record<string, unknown>;
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
    parsed.push({
      target,
      key_suffix: keySuffix,
      value: (e.value ?? {}) as Record<string, unknown>,
      entry: e,
    });
    targets.add(target);
  }
  if (parsed.length === 0) {
    return { data: { account_id: accountId, endorsing: {} } };
  }

  // Batch-fetch target profiles. Targets that have never heartbeated
  // return no profile — synthesize a null-fielded summary below.
  const profiles = await fetchProfiles([...targets]);
  const profileMap = new Map<string, ReturnType<typeof profileSummary>>();
  for (const p of profiles) profileMap.set(p.account_id, profileSummary(p));

  const endorsing: Record<
    string,
    {
      target: ReturnType<typeof profileSummary>;
      entries: Array<{
        key_suffix: string;
        reason?: string;
        content_hash?: string;
        at: number;
        at_height: number;
      }>;
    }
  > = {};

  for (const edge of parsed) {
    const summary = profileMap.get(edge.target) ?? {
      account_id: edge.target,
      name: null,
      description: '',
      image: null,
    };
    if (!endorsing[edge.target]) {
      endorsing[edge.target] = { target: summary, entries: [] };
    }
    endorsing[edge.target].entries.push({
      key_suffix: edge.key_suffix,
      reason:
        typeof edge.value.reason === 'string' ? edge.value.reason : undefined,
      content_hash:
        typeof edge.value.content_hash === 'string'
          ? edge.value.content_hash
          : undefined,
      // Block-authoritative — the endorser cannot backdate by lying in
      // the stored value blob.
      at: entryBlockSecs(edge.entry),
      at_height: entryBlockHeight(edge.entry),
    });
  }

  return {
    data: {
      account_id: accountId,
      endorsing,
    },
  };
}

// ---------------------------------------------------------------------------
// Activity & network handlers
// ---------------------------------------------------------------------------

async function handleGetActivity(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  // Opaque `block_height` cursor; absent cursor means "everything" — no
  // wall-clock default, so the feed can't depend on server time.
  const cursorRaw = body.cursor;
  let cursor: number | undefined;
  if (cursorRaw !== undefined) {
    const parsed =
      typeof cursorRaw === 'string'
        ? parseInt(cursorRaw, 10)
        : Number(cursorRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        error: 'cursor must be a non-negative integer block_height',
        status: 400,
      };
    }
    cursor = parsed;
  }

  // Trust FastData-indexed `block_height` over caller-asserted value
  // fields — the activity feed can't be gamed by backdating edges.
  const [followerEntries, followingEntries] = await Promise.all([
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);

  const afterCursor = (e: KvEntry): boolean =>
    cursor === undefined || entryBlockHeight(e) > cursor;

  const newFollowerAccounts: string[] = [];
  let maxHeight = cursor ?? 0;
  for (const e of followerEntries) {
    if (afterCursor(e)) {
      newFollowerAccounts.push(e.predecessor_id);
      if (e.block_height > maxHeight) maxHeight = e.block_height;
    }
  }

  const newFollowingAccountIds: string[] = [];
  for (const e of followingEntries) {
    if (afterCursor(e)) {
      newFollowingAccountIds.push(e.key.replace('graph/follow/', ''));
      if (e.block_height > maxHeight) maxHeight = e.block_height;
    }
  }

  const [followerAgents, followingAgents] = await Promise.all([
    fetchProfiles(newFollowerAccounts),
    fetchProfiles(newFollowingAccountIds),
  ]);
  const newFollowers = followerAgents.map(profileSummary);
  const newFollowing = followingAgents.map(profileSummary);

  // Next cursor: max block_height observed across the cursor-filtered raw
  // entries (follower/following edges that passed `afterCursor`), NOT the
  // post-profile-filter summary arrays. A window full of new edges pointing
  // at agents with no `profile` blob would drop every summary to zero while
  // still advancing the high-water mark; echoing the input cursor there
  // strands callers in a re-read loop. Cursor stays on the input value only
  // when no raw entries advanced it at all.
  const nextCursor = maxHeight > (cursor ?? 0) ? maxHeight : cursor;

  return {
    data: {
      cursor: nextCursor,
      new_followers: newFollowers,
      new_following: newFollowing,
    },
  };
}

async function handleGetNetwork(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const [agent, followerEntries, followingEntries] = await Promise.all([
    fetchProfile(accountId),
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  if (!agent) return { error: 'Agent not found', status: 404 };

  const followerAccounts = new Set(
    followerEntries.map((e) => e.predecessor_id),
  );
  const followingAccountIds = followingEntries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

  let mutualCount = 0;
  for (const a of followingAccountIds) {
    if (followerAccounts.has(a)) mutualCount++;
  }

  return {
    data: {
      follower_count: followerAccounts.size,
      following_count: followingAccountIds.length,
      mutual_count: mutualCount,
      last_active: agent.last_active,
      last_active_height: agent.last_active_height,
      created_at: agent.created_at,
      created_height: agent.created_height,
    },
  };
}
