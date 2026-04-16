/**
 * @jest-environment node
 */

import * as fastdata from '@/lib/fastdata';
import {
  fetchAllProfiles,
  fetchProfile,
  fetchProfiles,
} from '@/lib/fastdata-utils';

jest.mock('@/lib/fastdata');

const mockKvGetAgent = fastdata.kvGetAgent as jest.MockedFunction<
  typeof fastdata.kvGetAgent
>;
const mockKvGetAgentFirstWrite =
  fastdata.kvGetAgentFirstWrite as jest.MockedFunction<
    typeof fastdata.kvGetAgentFirstWrite
  >;
const mockKvMultiAgent = fastdata.kvMultiAgent as jest.MockedFunction<
  typeof fastdata.kvMultiAgent
>;
const mockKvGetAll = fastdata.kvGetAll as jest.MockedFunction<
  typeof fastdata.kvGetAll
>;

function profileEntry(
  predecessorId: string,
  value: unknown,
  blockTimestamp = 1_700_000_000_000_000_000,
  blockHeight = 1,
): fastdata.KvEntry {
  return {
    predecessor_id: predecessorId,
    current_account_id: 'contextual.near',
    block_height: blockHeight,
    block_timestamp: blockTimestamp,
    key: 'profile',
    value,
  };
}

beforeEach(() => {
  mockKvGetAgent.mockReset();
  mockKvGetAgentFirstWrite.mockReset();
  mockKvMultiAgent.mockReset();
  mockKvGetAll.mockReset();
});

// The wrappers exist to enforce FastData's trust boundary: the
// predecessor namespace (who wrote the key) is authoritative, and the
// stored blob's own `account_id` field is content that may be stale,
// missing, or corrupt. These tests verify the override actually fires
// — the rest of the suite uses fixtures whose stored account_id
// matches the lookup key, which is a no-op case.

describe('fetchProfile', () => {
  it('overrides stale account_id in the stored blob', async () => {
    mockKvGetAgent.mockResolvedValue(
      profileEntry('alice.near', {
        account_id: 'imposter.near',
        name: 'Alice',
        tags: ['ai'],
      }),
    );

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('account_id', 'alice.near');
    expect(result).toHaveProperty('name', 'Alice');
  });

  it('overrides caller-asserted last_active with block timestamp', async () => {
    // The caller claims year 2286; the block was indexed at 1_700_000_000s.
    // The override prevents sort=active manipulation. The literal is kept
    // within JS's safe integer range (round nanoseconds) to satisfy Biome.
    mockKvGetAgent.mockResolvedValue(
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', name: 'Alice', last_active: 9_999_999_999 },
        1_700_000_000_500_000_000,
      ),
    );

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('last_active', 1_700_000_000);
  });

  it('sets last_active_height from the entry block_height', async () => {
    // The block-height companion of last_active. Step 2 of the wall
    // clock → block height transition: every read path that derives
    // `last_active` from `block_timestamp` also surfaces the raw
    // `block_height` as the canonical "when" value. The stored blob
    // has no `last_active_height` slot (and never will — it's
    // read-derived), so this test just asserts the override fires
    // with the raw block_height value from the entry.
    mockKvGetAgent.mockResolvedValue(
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', name: 'Alice' },
        1_700_000_000_000_000_000,
        123_456_789,
      ),
    );

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('last_active_height', 123_456_789);
  });

  it('populates both created_at and created_height from the first-write entry', async () => {
    // Step 3 of the wall clock → block height transition: fetchProfile
    // fans out to the latest entry (for last_active / last_active_height)
    // and the first-write entry (for created_at / created_height). Both
    // block-derived fields ship together on every single-profile read.
    // The first-write block_timestamp and block_height are deliberately
    // distinct from the latest entry's values — the assertion catches
    // any regression that crosses them.
    mockKvGetAgent.mockResolvedValue(
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', name: 'Alice' },
        1_700_005_000_000_000_000,
        200,
      ),
    );
    mockKvGetAgentFirstWrite.mockResolvedValue(
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', name: 'Alice' },
        1_700_000_000_000_000_000,
        100,
      ),
    );

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('last_active', 1_700_005_000);
    expect(result).toHaveProperty('last_active_height', 200);
    expect(result).toHaveProperty('created_at', 1_700_000_000);
    expect(result).toHaveProperty('created_height', 100);
  });

  it('leaves created fields absent when history fetch returns null', async () => {
    // If the first-write entry is missing (history call failed, or the
    // agent's first write hasn't been indexed yet), both created fields
    // stay genuinely absent from the returned Agent — `foldProfile`
    // destructured them out and fetchProfile does not re-assign when
    // firstWrite is null. We never fall back to the latest entry's block
    // values, because that would conflate "when was this written" with
    // "when was this first written" and re-introduce a manipulation gap.
    mockKvGetAgent.mockResolvedValue(
      profileEntry('alice.near', { account_id: 'alice.near', name: 'Alice' }),
    );
    mockKvGetAgentFirstWrite.mockResolvedValue(null);

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('created_at');
    expect(result).not.toHaveProperty('created_height');
  });

  it('returns null when the entry is null', async () => {
    mockKvGetAgent.mockResolvedValue(null);
    expect(await fetchProfile('alice.near')).toBeNull();
  });

  it('returns null when the stored blob is a primitive', async () => {
    mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', 'oops'));
    expect(await fetchProfile('alice.near')).toBeNull();
  });

  it('returns null when the stored blob is an array', async () => {
    // Arrays are `typeof 'object'`; spreading one would yield a "profile"
    // with numeric-string keys. `foldProfile` must reject arrays
    // explicitly or this class of garbage leaks through.
    mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', [1, 2, 3]));
    expect(await fetchProfile('alice.near')).toBeNull();
  });
});

describe('fetchProfiles', () => {
  it('returns paired agents with authoritative account_ids', async () => {
    mockKvMultiAgent.mockResolvedValue([
      profileEntry('alice.near', { account_id: 'wrong1', name: 'A' }),
      profileEntry('bob.near', { account_id: 'wrong2', name: 'B' }),
    ]);

    const result = await fetchProfiles(['alice.near', 'bob.near']);
    expect(result).toHaveLength(2);
    expect(result[0].account_id).toBe('alice.near');
    expect(result[0].name).toBe('A');
    expect(result[1].account_id).toBe('bob.near');
    expect(result[1].name).toBe('B');
  });

  it('overrides last_active from each entry block_timestamp', async () => {
    // Per-entry block times must override caller-asserted `last_active`
    // on every profile in a batch, not just the single `fetchProfile`
    // path — otherwise `sort=active` under tag/cap filters is gameable.
    mockKvMultiAgent.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', last_active: 9_999_999_999 },
        1_700_000_001_000_000_000,
      ),
      profileEntry(
        'bob.near',
        { account_id: 'bob.near', last_active: 1 },
        1_700_000_002_000_000_000,
      ),
    ]);

    const result = await fetchProfiles(['alice.near', 'bob.near']);
    expect(result[0].last_active).toBe(1_700_000_001);
    expect(result[1].last_active).toBe(1_700_000_002);
  });

  it('surfaces last_active_height from each entry block_height', async () => {
    // Batch reads preserve the height override per-entry, not just the
    // seconds override. Same audit-closure argument as last_active:
    // sort=active under tag/cap filters must cursor on block_height
    // once step 4 migrates delta queries.
    mockKvMultiAgent.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near' },
        1_700_000_001_000_000_000,
        100,
      ),
      profileEntry(
        'bob.near',
        { account_id: 'bob.near' },
        1_700_000_002_000_000_000,
        200,
      ),
    ]);

    const result = await fetchProfiles(['alice.near', 'bob.near']);
    expect(result[0].last_active_height).toBe(100);
    expect(result[1].last_active_height).toBe(200);
  });

  it('drops null entries without shifting the remaining indices', async () => {
    mockKvMultiAgent.mockResolvedValue([
      profileEntry('alice.near', { account_id: 'whatever', name: 'A' }),
      null,
      profileEntry('carol.near', { account_id: 'whatever', name: 'C' }),
    ]);

    const result = await fetchProfiles([
      'alice.near',
      'bob.near',
      'carol.near',
    ]);
    expect(result).toHaveLength(2);
    // Dropped entry for bob.near — remaining agents keep their authoritative ids.
    expect(result[0].account_id).toBe('alice.near');
    expect(result[1].account_id).toBe('carol.near');
  });

  it('short-circuits on empty input without hitting the KV layer', async () => {
    const result = await fetchProfiles([]);
    expect(result).toEqual([]);
    expect(mockKvMultiAgent).not.toHaveBeenCalled();
  });

  it('strips every trust-boundary and derived field from legacy blobs', async () => {
    // List paths don't overlay live counts or join history — whatever
    // `foldProfile` returns is what callers see. A legacy blob
    // written before the write-side strippers landed could carry forged
    // values in any of the eight trust-boundary-owned fields; this test
    // is the read-side complement of the `buildHeartbeat` / `buildUpdateMe`
    // write-side strip guard in `packages/sdk/__tests__/social.test.ts`
    // and ensures those forged values never surface from a bulk read.
    mockKvMultiAgent.mockResolvedValue([
      profileEntry(
        'alice.near',
        {
          account_id: 'imposter.near',
          name: 'Alice',
          description: 'Real Alice',
          image: null,
          tags: ['ai'],
          capabilities: {},
          last_active: 9_999_999_999,
          last_active_height: 9_999_999,
          created_at: 9_999_999_999,
          created_height: 9_999_999,
          follower_count: 999,
          following_count: 888,
          endorsement_count: 777,
          endorsements: { 'forged/key': 666 },
        },
        1_700_000_000_000_000_000,
        1_234,
      ),
    ]);

    const [agent] = await fetchProfiles(['alice.near']);

    // Trust-boundary overrides fire — account_id from predecessor,
    // last_active / last_active_height from the entry's block fields.
    expect(agent.account_id).toBe('alice.near');
    expect(agent.last_active).toBe(1_700_000_000);
    expect(agent.last_active_height).toBe(1_234);
    // Forged fields with no authoritative replacement are genuinely
    // absent — not present with undefined — on list paths that don't
    // re-populate from a history map or overlay live counts.
    expect(agent).not.toHaveProperty('created_at');
    expect(agent).not.toHaveProperty('created_height');
    expect(agent).not.toHaveProperty('follower_count');
    expect(agent).not.toHaveProperty('following_count');
    expect(agent).not.toHaveProperty('endorsement_count');
    expect(agent).not.toHaveProperty('endorsements');
    // Canonical self-authored content is preserved.
    expect(agent.name).toBe('Alice');
    expect(agent.description).toBe('Real Alice');
    expect(agent.tags).toEqual(['ai']);
  });
});

describe('fetchAllProfiles', () => {
  it('uses each entry predecessor_id as the authoritative account_id', async () => {
    mockKvGetAll.mockResolvedValue([
      profileEntry('alice.near', { account_id: 'lying.near', name: 'Alice' }),
      profileEntry('bob.near', { account_id: 'also.lying', name: 'Bob' }),
    ]);

    const result = await fetchAllProfiles();
    expect(result).toHaveLength(2);
    expect(result[0].account_id).toBe('alice.near');
    expect(result[0].name).toBe('Alice');
    expect(result[1].account_id).toBe('bob.near');
    expect(result[1].name).toBe('Bob');
  });

  it('overrides caller-asserted last_active with block timestamp', async () => {
    mockKvGetAll.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', last_active: 9_999_999_999 },
        1_700_000_000_000_000_000,
      ),
    ]);
    const result = await fetchAllProfiles();
    expect(result[0].last_active).toBe(1_700_000_000);
  });

  it('surfaces last_active_height from the entry block_height', async () => {
    mockKvGetAll.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near' },
        1_700_000_000_000_000_000,
        42_000,
      ),
    ]);
    const result = await fetchAllProfiles();
    expect(result[0].last_active_height).toBe(42_000);
  });

  it('strips caller-asserted created_at from blobs (history is the only source)', async () => {
    // The blob carries an obviously-fake `created_at: 9_999_999_999`. The
    // trust boundary must drop it, leaving the field undefined for list
    // paths that don't fetch history. If the blob value leaked through,
    // sort=newest would be manipulable by writing a large `created_at`
    // into the profile blob — that's the exact gap the audit closes.
    mockKvGetAll.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', created_at: 9_999_999_999 },
        1_700_000_000_000_000_000,
      ),
    ]);
    const result = await fetchAllProfiles();
    expect(result[0].created_at).toBeUndefined();
  });

  it('drops entries whose value is not an object', async () => {
    mockKvGetAll.mockResolvedValue([
      profileEntry('alice.near', { name: 'Alice' }),
      profileEntry('bob.near', 'garbage'),
    ]);

    const result = await fetchAllProfiles();
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe('alice.near');
  });
});
