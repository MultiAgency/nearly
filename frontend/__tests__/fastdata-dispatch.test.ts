import { clearCache } from '@/lib/cache';
import * as fastdata from '@/lib/fastdata';
import { dispatchFastData } from '@/lib/fastdata-dispatch';
import {
  agentEntries,
  profileCompleteness,
  profileGaps,
} from '@/lib/fastdata-utils';
import type { Agent } from '@/types';
import { AGENT_ALICE } from './fixtures';

jest.mock('@/lib/constants', () => ({
  ...jest.requireActual('@/lib/constants'),
  OUTLAYER_ADMIN_ACCOUNT: 'admin.near',
}));
jest.mock('@/lib/fastdata');
jest.mock('@/lib/outlayer-server', () => ({
  getOperatorClaimsWriterAccount: jest.fn(),
}));

import * as outlayerServer from '@/lib/outlayer-server';

const mockGetOperatorClaimsWriterAccount =
  outlayerServer.getOperatorClaimsWriterAccount as jest.MockedFunction<
    typeof outlayerServer.getOperatorClaimsWriterAccount
  >;
const mockKvGetAgent = fastdata.kvGetAgent as jest.MockedFunction<
  typeof fastdata.kvGetAgent
>;
const mockKvGetAll = fastdata.kvGetAll as jest.MockedFunction<
  typeof fastdata.kvGetAll
>;
const mockKvListAgent = fastdata.kvListAgent as jest.MockedFunction<
  typeof fastdata.kvListAgent
>;
const mockKvListAll = fastdata.kvListAll as jest.MockedFunction<
  typeof fastdata.kvListAll
>;
const mockKvMultiAgent = fastdata.kvMultiAgent as jest.MockedFunction<
  typeof fastdata.kvMultiAgent
>;
const mockKvHistoryFirstByPredecessor =
  fastdata.kvHistoryFirstByPredecessor as jest.MockedFunction<
    typeof fastdata.kvHistoryFirstByPredecessor
  >;

beforeEach(() => {
  jest.resetAllMocks();
  clearCache();
  mockKvGetAgent.mockResolvedValue(null);
  mockKvGetAll.mockResolvedValue([]);
  mockKvListAll.mockResolvedValue([]);
  mockKvListAgent.mockResolvedValue([]);
  mockKvMultiAgent.mockResolvedValue([]);
  // Default: operator-claims writer is unconfigured. Tests that exercise
  // the happy path override this to return a concrete writer account.
  mockGetOperatorClaimsWriterAccount.mockResolvedValue('');
});

// Block timestamp in nanoseconds (the units FastData uses). This fixed value
// resolves to the same second as the AGENT_ALICE `last_active`, so the
// trust-boundary override doesn't shift the timestamp in unrelated tests.
const FIXTURE_BLOCK_TS_NS = 1_700_000_000_000_000_000;

function entry(
  predecessorId: string,
  key: string,
  value: unknown,
): fastdata.KvEntry {
  return {
    predecessor_id: predecessorId,
    current_account_id: 'contextual.near',
    block_height: 100,
    block_timestamp: FIXTURE_BLOCK_TS_NS,
    key,
    value,
  };
}

/** Wrap a profile blob in a KvEntry with the standard fixture block time. */
function profileEntry(accountId: string, value: unknown): fastdata.KvEntry {
  return entry(accountId, 'profile', value);
}

function expectData(result: unknown): unknown {
  expect(result).toHaveProperty('data');
  return (result as { data: unknown }).data;
}

function expectError(result: unknown): string {
  expect(result).toHaveProperty('error');
  return (result as { error: string }).error;
}

describe('profileCompleteness', () => {
  // Per-field scoring (see fastdata-utils.ts):
  //   name         binary, 10 points
  //   description  binary, 20 points
  //   image        binary, 20 points
  //   tags         continuous, 2 points per tag up to 10 (cap 20)
  //   capabilities continuous, 10 points per leaf pair up to 3 (cap 30)
  // A score of 100 means "richly populated" (name, description, image, ≥10
  // tags, ≥3 capability pairs), not just "minimally filled." Fulfilling an
  // emitted action moves the score by at least 2 (tags) or 10 (caps, name)
  // or 20 (description, image) — agents use the score as a progress signal
  // across heartbeats, and a rising score means the human engaged.
  const COMPLETE_AGENT = {
    name: 'Alice',
    description: 'A description longer than 10 chars',
    image: 'https://example.com/avatar.png',
    // 10 tags hits the tag cap (10 × 2 = 20).
    tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'],
    // 3 leaf pairs hits the capability cap (3 × 10 = 30).
    capabilities: { skills: ['s1', 's2', 's3'] },
  };

  it('returns 100 when all fields are richly populated', () => {
    expect(profileGaps(COMPLETE_AGENT)).toEqual([]);
    expect(profileCompleteness(COMPLETE_AGENT)).toBe(100);
  });

  it('penalizes missing name', () => {
    expect(profileGaps({ ...COMPLETE_AGENT, name: null })).toContain('name');
  });

  it('penalizes missing description', () => {
    expect(profileGaps({ ...COMPLETE_AGENT, description: '' })).toContain(
      'description',
    );
  });

  it('penalizes description <= 10 chars', () => {
    expect(
      profileGaps({ ...COMPLETE_AGENT, description: '0123456789' }),
    ).toContain('description');
  });

  it('accepts description > 10 chars', () => {
    expect(
      profileGaps({ ...COMPLETE_AGENT, description: '01234567890' }),
    ).not.toContain('description');
  });

  it('penalizes empty tags', () => {
    expect(profileGaps({ ...COMPLETE_AGENT, tags: [] })).toContain('tags');
  });

  it('penalizes empty capabilities', () => {
    expect(profileGaps({ ...COMPLETE_AGENT, capabilities: {} })).toContain(
      'capabilities',
    );
  });

  it('penalizes missing image', () => {
    expect(profileGaps({ ...COMPLETE_AGENT, image: null })).toContain('image');
  });

  it('scores tags continuously (2 points per tag, cap 10)', () => {
    // 1 tag: 10 (name) + 20 (desc) + 20 (image) + 2 (tags) + 30 (caps) = 82
    expect(profileCompleteness({ ...COMPLETE_AGENT, tags: ['t1'] })).toBe(82);
    // 5 tags: ... + 10 (tags) ... = 90
    expect(
      profileCompleteness({
        ...COMPLETE_AGENT,
        tags: ['t1', 't2', 't3', 't4', 't5'],
      }),
    ).toBe(90);
    // 15 tags: capped at 10 → 20 (tags) → 100 total
    expect(
      profileCompleteness({
        ...COMPLETE_AGENT,
        tags: Array.from({ length: 15 }, (_, i) => `t${i}`),
      }),
    ).toBe(100);
  });

  it('scores capabilities continuously (10 points per leaf pair, cap 3)', () => {
    // 1 pair: 10 (name) + 20 (desc) + 20 (image) + 20 (tags) + 10 (caps) = 80
    expect(
      profileCompleteness({
        ...COMPLETE_AGENT,
        capabilities: { skills: ['s1'] },
      }),
    ).toBe(80);
    // 5 pairs: capped at 3 → 30 (caps) → 100 total
    expect(
      profileCompleteness({
        ...COMPLETE_AGENT,
        capabilities: {
          skills: ['s1', 's2', 's3'],
          languages: ['l1', 'l2'],
        },
      }),
    ).toBe(100);
  });

  it('scores AGENT_ALICE at 24 (description 20 + tags 4; name, capabilities, image missing)', () => {
    // AGENT_ALICE: name: null (0), description: "Test agent Alice" (20),
    // image: null (0), tags: ['ai','defi'] → 2 × 2 = 4, capabilities: {} (0).
    // Total = 20 + 4 = 24.
    expect(
      profileCompleteness(
        AGENT_ALICE as Parameters<typeof profileCompleteness>[0],
      ),
    ).toBe(24);
  });
});

describe('agentEntries', () => {
  // Load-bearing invariant: stored profile is canonical self-authored state.
  // Counts are derived at read time via liveNetworkCounts / withLiveCounts
  // and never written to FastData. Regressing this pollutes storage
  // persistently — a downstream "list endpoints omit counts" test would
  // catch nothing if storage already holds stale counts. See the project
  // plan's "Storage invariant enforced" entry and the Do-not rule against
  // re-introducing bulk count enrichment.
  it('strips derived count and endorsement fields before write', () => {
    const agent: Agent = {
      account_id: 'alice.near',
      name: 'Alice',
      description: 'Test agent with a sufficient description',
      image: null,
      tags: ['ai'],
      capabilities: { skills: ['testing'] },
      created_at: 1700000000,
      last_active: 1700001000,
      follower_count: 42,
      following_count: 7,
      endorsement_count: 3,
      endorsements: { 'skills/testing': 2 },
    };

    const entries = agentEntries(agent);
    const stored = entries.profile as Record<string, unknown>;

    expect(stored).not.toHaveProperty('follower_count');
    expect(stored).not.toHaveProperty('following_count');
    expect(stored).not.toHaveProperty('endorsement_count');
    expect(stored).not.toHaveProperty('endorsements');

    // Canonical fields are preserved.
    expect(stored.account_id).toBe('alice.near');
    expect(stored.name).toBe('Alice');
    expect(stored.description).toBe('Test agent with a sufficient description');
    expect(stored.tags).toEqual(['ai']);
    expect(stored.capabilities).toEqual({ skills: ['testing'] });
    // Time fields are read-derived from FastData block_timestamp and
    // must not leak into the stored blob — caller-asserted values would
    // give agents a way to appear eternally fresh in sort=active.
    expect(stored).not.toHaveProperty('created_at');
    expect(stored).not.toHaveProperty('last_active');

    // Tag and capability index keys are still written alongside profile.
    expect(entries['tag/ai']).toBe(true);
    expect(entries['cap/skills/testing']).toBe(true);
  });
});

describe('dispatchFastData', () => {
  describe('unsupported actions', () => {
    it('returns error for unknown action', async () => {
      const err = expectError(await dispatchFastData('bogus_action', {}));
      expect(err).toContain('Unsupported');
    });
  });

  describe('profile', () => {
    it('reads profile by account_id', async () => {
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));
      const data = expectData(
        await dispatchFastData('profile', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect((data.agent as Record<string, unknown>).account_id).toBe(
        'alice.near',
      );
    });

    it('returns 404 when account not found', async () => {
      mockKvGetAgent.mockResolvedValue(null);
      const err = expectError(
        await dispatchFastData('profile', { account_id: 'nobody.near' }),
      );
      expect(err).toContain('not found');
    });

    it('returns error when account_id is missing', async () => {
      const err = expectError(await dispatchFastData('profile', {}));
      expect(err).toContain('account_id');
    });

    it('omits is_following and my_endorsements when caller is not set', async () => {
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));
      const data = expectData(
        await dispatchFastData('profile', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect(data).not.toHaveProperty('is_following');
      expect(data).not.toHaveProperty('my_endorsements');
    });

    it('populates is_following=true when caller follows the target', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
        if (accountId === 'bob.near' && key === 'graph/follow/alice.near')
          return entry('bob.near', 'graph/follow/alice.near', {
            at: 1700000000,
          });
        return null;
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data.is_following).toBe(true);
      expect(data.my_endorsements).toEqual([]);
    });

    it('populates is_following=false when caller does not follow', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
        return null;
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data.is_following).toBe(false);
      expect(data.my_endorsements).toEqual([]);
    });

    it('returns my_endorsements as a flat list of key_suffixes', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
        return null;
      });
      mockKvListAgent.mockImplementation(async (accountId, prefix) => {
        if (accountId === 'bob.near' && prefix === 'endorsing/alice.near/') {
          return [
            entry('bob.near', 'endorsing/alice.near/tags/ai', {
              at: 1700000000,
            }),
            entry('bob.near', 'endorsing/alice.near/tags/defi', {
              at: 1700000000,
            }),
            entry('bob.near', 'endorsing/alice.near/skills/testing', {
              at: 1700000000,
            }),
          ];
        }
        return [];
      });
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data.my_endorsements).toEqual([
        'tags/ai',
        'tags/defi',
        'skills/testing',
      ]);
    });

    it('returns zero caller context when caller is the target', async () => {
      // Self-follow and self-endorse are blocked at write time, so the
      // natural KV lookups yield is_following=false and my_endorsements=[].
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
        return null;
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'alice.near',
        }),
      ) as Record<string, unknown>;
      expect(data.is_following).toBe(false);
      expect(data.my_endorsements).toEqual([]);
    });

    it('falls back to unenriched profile when caller context lookup fails', async () => {
      // The profile read succeeds; the follow-edge lookup fails. With a
      // single kvGetAgent, split by key via mockImplementation.
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
        throw new Error('fastdata down');
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data).toHaveProperty('agent');
      expect(data).not.toHaveProperty('is_following');
      expect(data).not.toHaveProperty('my_endorsements');
    });
  });

  describe('list_tags', () => {
    it('aggregates tag counts from all agents', async () => {
      mockKvListAll.mockResolvedValue([
        entry('alice.near', 'tag/ai', { score: 5 }),
        entry('bob.near', 'tag/ai', { score: 3 }),
        entry('alice.near', 'tag/defi', { score: 5 }),
      ]);
      const data = expectData(
        await dispatchFastData('list_tags', {}),
      ) as Record<string, unknown>;
      const tags = data.tags as { tag: string; count: number }[];
      expect(tags[0]).toEqual({ tag: 'ai', count: 2 });
      expect(tags[1]).toEqual({ tag: 'defi', count: 1 });
    });
  });

  describe('list_capabilities', () => {
    it('aggregates capability counts from all agents', async () => {
      mockKvListAll.mockResolvedValue([
        entry('alice.near', 'cap/skills/testing', { score: 5 }),
        entry('bob.near', 'cap/skills/testing', { score: 3 }),
        entry('alice.near', 'cap/languages/python', { score: 5 }),
      ]);
      const data = expectData(
        await dispatchFastData('list_capabilities', {}),
      ) as Record<string, unknown>;
      const caps = data.capabilities as {
        namespace: string;
        value: string;
        count: number;
      }[];
      expect(caps[0]).toEqual({
        namespace: 'skills',
        value: 'testing',
        count: 2,
      });
      expect(caps[1]).toEqual({
        namespace: 'languages',
        value: 'python',
        count: 1,
      });
    });
  });

  describe('list_agents', () => {
    it('filters by tag', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'tag/ai', { score: 10 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('alice.near', AGENT_ALICE),
      ]);

      const data = expectData(
        await dispatchFastData('list_agents', { tag: 'ai' }),
      ) as Record<string, unknown>;
      expect((data.agents as unknown[]).length).toBe(1);
      expect(mockKvGetAll).toHaveBeenCalledWith('tag/ai');
    });

    it('filters by capability', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'cap/skills/testing', { score: 10 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('alice.near', AGENT_ALICE),
      ]);

      const data = expectData(
        await dispatchFastData('list_agents', { capability: 'skills/testing' }),
      ) as Record<string, unknown>;
      expect((data.agents as unknown[]).length).toBe(1);
      // Verify kvGetAll was called with the capability key
      expect(mockKvGetAll).toHaveBeenCalledWith('cap/skills/testing');
    });

    it('keeps hidden agents in list_agents results without a hidden flag', async () => {
      const bob = { ...AGENT_ALICE, account_id: 'bob.near' };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', AGENT_ALICE),
            entry('bob.near', 'profile', bob),
          ];
        return [];
      });
      // Admin has hidden bob — hiding is a presentation concern, not a data
      // one. The backend returns raw graph truth; no flag is stamped.
      mockKvListAgent.mockImplementation(async (id: string, prefix: string) => {
        if (id === 'admin.near' && prefix === 'hidden/')
          return [entry('admin.near', 'hidden/bob.near', { at: 1000 })];
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', { limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      const byId = Object.fromEntries(agents.map((a) => [a.account_id, a]));
      expect(byId['bob.near']).toBeDefined();
      expect(byId['bob.near'].hidden).toBeUndefined();
      expect(byId['alice.near'].hidden).toBeUndefined();
    });

    it('sorts by newest (block_timestamp of first profile write, descending)', async () => {
      // sort=newest is driven by `kvHistoryFirstByPredecessor` returning
      // the FIRST profile write's KvEntry per agent. The block_timestamp
      // on each entry determines ordering — NOT any caller-asserted
      // `created_at` field on the profile blob (those are stripped by
      // applyTrustBoundary). To prove the test isn't accidentally
      // passing through the bug we just fixed, the blob carries an
      // ANTI-CORRELATED `created_at` (alice's blob value is bigger than
      // bob's) but the history entries set bob's first write later than
      // alice's. The expected order follows the history, not the blob.
      const bob = { ...AGENT_ALICE, account_id: 'bob.near', created_at: 1 };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', AGENT_ALICE),
            entry('bob.near', 'profile', bob),
          ];
        return [];
      });
      mockKvHistoryFirstByPredecessor.mockResolvedValue(
        new Map([
          [
            'alice.near',
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 100,
              block_timestamp: 1_700_000_000_000_000_000,
              key: 'profile',
              value: {},
            },
          ],
          [
            'bob.near',
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 200,
              block_timestamp: 1_700_002_000_000_000_000,
              key: 'profile',
              value: {},
            },
          ],
        ]),
      );

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'newest', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Bob's first write block_timestamp is later than Alice's, so bob
      // is newer — even though alice's BLOB has a larger caller-asserted
      // created_at. The trust boundary strips the blob value; the join
      // from kvHistoryFirstByPredecessor sets the block-derived value.
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[1].account_id).toBe('alice.near');
    });

    it('sorts by active (block_timestamp descending)', async () => {
      // `last_active` is overridden by the trust boundary with each entry's
      // block_timestamp, so the sort order is driven by the FastData-indexed
      // time of the profile write — not by whatever the caller claims in
      // the value blob. Stored `last_active` values below are intentionally
      // reversed from the block_timestamp ordering to verify the override.
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
        last_active: 1700001000, // lower than Alice's in the stored value
      };
      const alice = {
        ...AGENT_ALICE,
        last_active: 1700005000, // higher, but her block_timestamp is older
      };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 100,
              block_timestamp: 1_700_001_000_000_000_000,
              key: 'profile',
              value: alice,
            },
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 101,
              block_timestamp: 1_700_005_000_000_000_000,
              key: 'profile',
              value: bob,
            },
          ];
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'active', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Bob's block_timestamp (1_700_005_000 s) is newer than Alice's
      // (1_700_001_000 s), so Bob ranks first — independent of the
      // values in the stored profile blobs.
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[1].account_id).toBe('alice.near');
    });
  });

  describe('followers', () => {
    it('returns agents who follow the account', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('bob.near', 'graph/follow/alice.near', { at: 1700000000 }),
        entry('carol.near', 'graph/follow/alice.near', { at: 1700000001 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
        profileEntry('carol.near', {
          ...AGENT_ALICE,
          account_id: 'carol.near',
        }),
      ]);

      const data = expectData(
        await dispatchFastData('followers', {
          account_id: 'alice.near',
          limit: 25,
        }),
      ) as Record<string, unknown>;
      expect(data.account_id).toBe('alice.near');
      expect((data.followers as unknown[]).length).toBe(2);
      expect(mockKvGetAll).toHaveBeenCalledWith('graph/follow/alice.near');
    });
  });

  describe('me', () => {
    it('returns profile with computed completeness', async () => {
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));

      const data = expectData(
        await dispatchFastData('me', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect((data.agent as Record<string, unknown>).account_id).toBe(
        'alice.near',
      );
      expect(data.profile_completeness).toBe(24); // description (20) + tags 2*2 (4); name, capabilities, image missing
    });
  });

  describe('discover_agents', () => {
    it('returns scored suggestions excluding self and followed', async () => {
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
        tags: ['ai'],
      };
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));
      mockKvListAgent.mockResolvedValue([]); // no follows yet
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'profile', AGENT_ALICE),
        entry('bob.near', 'profile', bob),
      ]);

      const data = expectData(
        await dispatchFastData('discover_agents', {
          account_id: 'alice.near',
          limit: 10,
        }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      // Alice should be filtered (self), only bob remains
      expect(agents.length).toBe(1);
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[0].reason).toContain('Shared tags');
    });
  });

  describe('activity (handleGetActivity)', () => {
    /**
     * Build a follow-edge KvEntry with explicit block_height. The shared
     * `entry()` helper hardcodes block_height to 100, which is fine for the
     * rest of the suite but useless for cursor semantics — here we need to
     * distinguish entries by their block_height to verify that `cursor`
     * filtering compares on height, not seconds.
     */
    function followEdge(
      predecessorId: string,
      targetAccountId: string,
      blockHeight: number,
    ): fastdata.KvEntry {
      return {
        predecessor_id: predecessorId,
        current_account_id: 'contextual.near',
        block_height: blockHeight,
        block_timestamp: FIXTURE_BLOCK_TS_NS,
        key: `graph/follow/${targetAccountId}`,
        value: {},
      };
    }

    it('returns every inbound edge when the cursor is absent', async () => {
      mockKvGetAll.mockImplementation(async (key) => {
        if (key === 'graph/follow/alice.near') {
          return [
            followEdge('bob.near', 'alice.near', 100),
            followEdge('carol.near', 'alice.near', 200),
            followEdge('dave.near', 'alice.near', 300),
          ];
        }
        return [];
      });
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
        profileEntry('carol.near', {
          ...AGENT_ALICE,
          account_id: 'carol.near',
        }),
        profileEntry('dave.near', { ...AGENT_ALICE, account_id: 'dave.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('activity', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;

      const newFollowers = data.new_followers as { account_id: string }[];
      expect(newFollowers).toHaveLength(3);
      expect(data.cursor).toBe(300);
    });

    it('returns only edges strictly after the cursor block_height', async () => {
      mockKvGetAll.mockImplementation(async (key) => {
        if (key === 'graph/follow/alice.near') {
          return [
            followEdge('bob.near', 'alice.near', 100),
            followEdge('carol.near', 'alice.near', 200),
            followEdge('dave.near', 'alice.near', 300),
          ];
        }
        return [];
      });
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('dave.near', { ...AGENT_ALICE, account_id: 'dave.near' }),
      ]);

      // Cursor = 200 (the previous response's max). The caller should
      // receive only the 300-height entry — strictly greater, not equal.
      // This is the core cursoring semantic: re-querying with the cursor
      // from the previous response is idempotent on state that hasn't
      // changed.
      const data = expectData(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: '200',
        }),
      ) as Record<string, unknown>;

      const newFollowers = data.new_followers as { account_id: string }[];
      expect(newFollowers).toHaveLength(1);
      expect(newFollowers[0].account_id).toBe('dave.near');
      expect(data.cursor).toBe(300);
    });

    it('echoes the input cursor when no new entries are returned', async () => {
      // Re-cursoring at the high-water mark on a stable graph: the caller
      // passes back 300 after receiving it in the previous response, and
      // nothing moves. The response should echo 300 back so the caller
      // can keep polling from the same position without losing state.
      mockKvGetAll.mockImplementation(async (key) => {
        if (key === 'graph/follow/alice.near') {
          return [
            followEdge('bob.near', 'alice.near', 100),
            followEdge('carol.near', 'alice.near', 200),
            followEdge('dave.near', 'alice.near', 300),
          ];
        }
        return [];
      });

      const data = expectData(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: '300',
        }),
      ) as Record<string, unknown>;

      expect(data.new_followers).toEqual([]);
      expect(data.new_following).toEqual([]);
      expect(data.cursor).toBe(300);
    });

    it('rejects a non-numeric cursor with a validation error', async () => {
      const err = expectError(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: 'garbage',
        }),
      );
      expect(err).toContain('cursor');
    });

    it('rejects a negative cursor with a validation error', async () => {
      const err = expectError(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: '-1',
        }),
      );
      expect(err).toContain('cursor');
    });
  });

  describe('error handling', () => {
    it('returns error on fetch failure', async () => {
      mockKvGetAgent.mockRejectedValue(new Error('network error'));
      const err = expectError(
        await dispatchFastData('profile', { account_id: 'alice.near' }),
      );
      expect(err).toContain('network error');
    });
  });

  describe('agent_claims (handleAgentClaims)', () => {
    const WRITER = 'nearly-claims-writer.near';
    const AGENT = 'bob.near';

    /**
     * Build a single operator-claim KV entry as the writer-account
     * predecessor. The key encodes both identities; the value carries the
     * full NEP-413 envelope the handler parses the authoritative operator
     * identity out of.
     */
    function claimEntry(
      operator: string,
      agent: string,
      opts: {
        reason?: string;
        malformedMessage?: boolean;
        missingAccountId?: boolean;
      } = {},
    ): fastdata.KvEntry {
      const inner: Record<string, unknown> = {
        action: 'claim_operator',
        domain: 'nearly.social',
        version: 1,
        timestamp: 1_700_000_000_000,
      };
      if (!opts.missingAccountId) inner.account_id = operator;
      const message = opts.malformedMessage
        ? 'not valid json {'
        : JSON.stringify(inner);
      return {
        predecessor_id: WRITER,
        current_account_id: 'contextual.near',
        block_height: 500,
        block_timestamp: FIXTURE_BLOCK_TS_NS,
        key: `operator/${operator}/${agent}`,
        value: {
          message,
          signature: 'ed25519:sig',
          public_key: 'ed25519:pk',
          nonce: 'base64nonce',
          ...(opts.reason != null && { reason: opts.reason }),
        },
      };
    }

    it('returns empty list when writer account is unconfigured', async () => {
      // Default: writer returns '' — feature disabled on this deployment.
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as { account_id: string; operators: unknown[] };
      expect(data.account_id).toBe(AGENT);
      expect(data.operators).toEqual([]);
      // Scan should not have run — no point if there's no writer account.
      expect(mockKvListAgent).not.toHaveBeenCalled();
    });

    it('returns empty list when no operator entries exist in the namespace', async () => {
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as { account_id: string; operators: unknown[] };
      expect(data.operators).toEqual([]);
      expect(mockKvListAgent).toHaveBeenCalledWith(WRITER, 'operator/');
    });

    it('returns empty list when entries exist but none match the target agent', async () => {
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      mockKvListAgent.mockResolvedValue([
        claimEntry('alice.near', 'carol.near'),
        claimEntry('dave.near', 'carol.near'),
      ]);
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as { account_id: string; operators: unknown[] };
      expect(data.operators).toEqual([]);
    });

    it('surfaces a single matching operator with envelope fields', async () => {
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      mockKvListAgent.mockResolvedValue([
        claimEntry('alice.near', AGENT, { reason: 'original human' }),
      ]);
      // `fetchProfiles` goes through `kvMultiAgent` — return an alice profile
      // so the operator entry carries her display fields.
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('alice.near', {
          ...AGENT_ALICE,
          name: 'Alice',
          description: 'operator',
        }),
      ]);
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as {
        account_id: string;
        operators: Array<{
          account_id: string;
          name: string | null;
          description: string;
          image: string | null;
          message: string;
          signature: string;
          public_key: string;
          nonce: string;
          reason?: string;
          at?: number;
          at_height?: number;
        }>;
      };
      expect(data.operators).toHaveLength(1);
      expect(data.operators[0]).toMatchObject({
        account_id: 'alice.near',
        name: 'Alice',
        description: 'operator',
        signature: 'ed25519:sig',
        public_key: 'ed25519:pk',
        nonce: 'base64nonce',
        reason: 'original human',
      });
      // Block-authoritative timestamps, not caller-asserted.
      expect(data.operators[0].at_height).toBe(500);
      expect(data.operators[0].at).toBe(Math.floor(FIXTURE_BLOCK_TS_NS / 1e9));
      // The inner-message JSON round-trips verbatim for independent re-verify.
      expect(JSON.parse(data.operators[0].message)).toMatchObject({
        account_id: 'alice.near',
        action: 'claim_operator',
      });
    });

    it('filters entries whose key_suffix only happens to contain the agent id', async () => {
      // `operator/alice.near/{not-the-agent}` shares the agent-ID substring
      // but ends with a different slash-bounded tail. Must not match.
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      mockKvListAgent.mockResolvedValue([
        claimEntry('alice.near', `${AGENT}.extra.near`),
        claimEntry('dave.near', AGENT),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('dave.near', { ...AGENT_ALICE, name: 'Dave' }),
      ]);
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as { operators: Array<{ account_id: string }> };
      expect(data.operators).toHaveLength(1);
      expect(data.operators[0].account_id).toBe('dave.near');
    });

    it('pulls the operator identity from the inner message, not the predecessor', async () => {
      // Every entry under the writer-account namespace carries the same
      // predecessor_id (the service account). The handler must parse
      // `message.account_id` to surface the authoritative operator.
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      mockKvListAgent.mockResolvedValue([
        claimEntry('alice.near', AGENT),
        claimEntry('dave.near', AGENT),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('alice.near', { ...AGENT_ALICE, name: 'Alice' }),
        profileEntry('dave.near', { ...AGENT_ALICE, name: 'Dave' }),
      ]);
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as { operators: Array<{ account_id: string; name: string | null }> };
      const ids = data.operators.map((o) => o.account_id).sort();
      expect(ids).toEqual(['alice.near', 'dave.near']);
      // Neither operator's account_id matches the writer predecessor — the
      // handler didn't fall back to `predecessor_id` attribution.
      expect(ids).not.toContain(WRITER);
    });

    it('drops entries whose NEP-413 message is malformed', async () => {
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      mockKvListAgent.mockResolvedValue([
        claimEntry('alice.near', AGENT, { malformedMessage: true }),
        claimEntry('dave.near', AGENT, { missingAccountId: true }),
        claimEntry('carol.near', AGENT),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('carol.near', { ...AGENT_ALICE, name: 'Carol' }),
      ]);
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as { operators: Array<{ account_id: string }> };
      // Only carol.near survives — alice's malformed JSON and dave's
      // missing inner account_id both get silently dropped.
      expect(data.operators).toHaveLength(1);
      expect(data.operators[0].account_id).toBe('carol.near');
    });

    it('surfaces operators even when their profile blob does not exist yet', async () => {
      // A named NEAR account can file an operator claim before ever calling
      // heartbeat — the envelope is the proof, the profile is optional
      // summary metadata.
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      mockKvListAgent.mockResolvedValue([
        claimEntry('ghost.near', AGENT, { reason: 'never joined the index' }),
      ]);
      // fetchProfiles returns empty — no profile for ghost.near.
      mockKvMultiAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('agent_claims', { account_id: AGENT }),
      ) as {
        operators: Array<{
          account_id: string;
          name: string | null;
          description: string;
          image: string | null;
          reason?: string;
        }>;
      };
      expect(data.operators).toHaveLength(1);
      expect(data.operators[0]).toMatchObject({
        account_id: 'ghost.near',
        name: null,
        description: '',
        image: null,
        reason: 'never joined the index',
      });
    });

    it('requires account_id in the request body', async () => {
      mockGetOperatorClaimsWriterAccount.mockResolvedValue(WRITER);
      const err = expectError(await dispatchFastData('agent_claims', {}));
      expect(err).toContain('account_id');
    });
  });
});
