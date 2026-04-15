import {
  defaultAgent,
  extractCapabilityPairs,
  foldProfile,
} from '../src/graph';
import { aliceProfileBlob, aliceProfileEntry, entry } from './fixtures/entries';

describe('graph.foldProfile', () => {
  it('uses the KvEntry predecessor_id as account_id', () => {
    const e = entry({
      predecessor_id: 'bob.near',
      key: 'profile',
      value: { ...aliceProfileBlob, account_id: 'alice.near' },
    });
    const agent = foldProfile(e);
    expect(agent!.account_id).toBe('bob.near');
  });

  it('overrides caller-asserted last_active with block_timestamp', () => {
    // block_timestamp is nanoseconds; the override divides by 1e9 and
    // floors to seconds. 1_700_000_000_500_000_000 ns → 1_700_000_000 s.
    // (Using a round number avoids JS number-literal precision loss — the
    // outer nine digits plus trailing zeros are all representable exactly.)
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: { ...aliceProfileBlob, last_active: 9_999_999_999 },
      block_timestamp: 1_700_000_000_500_000_000,
    });
    expect(foldProfile(e)?.last_active).toBe(1_700_000_000);
  });

  it('strips every trust-boundary and derived field from legacy blobs', () => {
    // `created_at` / `created_height` are only populated by read paths
    // that fetch FastData first-write history (`getAgent`, `listAgents`
    // sort=newest). Count / endorsement fields are overlaid elsewhere.
    // `foldProfile` must destructure all of them out of the blob so a
    // forged value in any slot can't leak into the returned Agent —
    // without this, sort=newest, sort=followers, and endorsement
    // rankings would all be manipulable by a malicious writer. This
    // test is the read-side complement of the write-side strip guard
    // in `mutations.test.ts::buildHeartbeat`.
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: {
        ...aliceProfileBlob,
        last_active: 9_999_999_999,
        last_active_height: 9_999_999,
        created_at: 9_999_999_999,
        created_height: 9_999_999,
        follower_count: 999,
        following_count: 888,
        endorsement_count: 777,
        endorsements: { 'forged/key': 666 },
      },
      block_timestamp: 1_700_000_000_000_000_000,
      block_height: 1_234,
    });
    const agent = foldProfile(e);
    // Trust-boundary overrides fire.
    expect(agent?.account_id).toBe('alice.near');
    expect(agent?.last_active).toBe(1_700_000_000);
    expect(agent?.last_active_height).toBe(1_234);
    // Forged fields with no authoritative replacement are genuinely
    // absent — not present with undefined — on foldProfile's return.
    for (const forbidden of [
      'created_at',
      'created_height',
      'follower_count',
      'following_count',
      'endorsement_count',
      'endorsements',
    ]) {
      expect(agent).not.toHaveProperty(forbidden);
    }
  });

  it('returns null when the entry value is a string', () => {
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: 'corrupted',
    });
    expect(foldProfile(e)).toBeNull();
  });

  it('returns null for arrays (typeof [] === object trap)', () => {
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: ['not', 'an', 'agent'],
    });
    expect(foldProfile(e)).toBeNull();
  });

  it('returns null for null/primitive values', () => {
    expect(
      foldProfile(entry({ predecessor_id: 'a', key: 'profile', value: null })),
    ).toBeNull();
    expect(
      foldProfile(entry({ predecessor_id: 'a', key: 'profile', value: 42 })),
    ).toBeNull();
  });

  it('round-trips a live profile entry', () => {
    const agent = foldProfile(aliceProfileEntry);
    expect(agent?.name).toBe('Alice');
    expect(agent?.tags).toEqual(['rust']);
  });
});

describe('graph.defaultAgent', () => {
  it('produces an empty profile with no time fields', () => {
    const a = defaultAgent('new.near');
    expect(a.account_id).toBe('new.near');
    expect(a.name).toBeNull();
    expect(a.description).toBe('');
    expect(a.tags).toEqual([]);
    expect(a.capabilities).toEqual({});
    expect(a.created_at).toBeUndefined();
    expect(a.last_active).toBeUndefined();
  });
});

describe('graph.extractCapabilityPairs', () => {
  it('flattens nested objects into dot-paths', () => {
    const pairs = extractCapabilityPairs({
      languages: { primary: 'Rust', secondary: 'TypeScript' },
    });
    expect(pairs).toContainEqual(['languages.primary', 'rust']);
    expect(pairs).toContainEqual(['languages.secondary', 'typescript']);
  });

  it('lowercases values', () => {
    const pairs = extractCapabilityPairs({ skills: ['Rust', 'Go'] });
    expect(pairs).toEqual([
      ['skills', 'rust'],
      ['skills', 'go'],
    ]);
  });

  it('caps depth at 4', () => {
    const deep = { a: { b: { c: { d: { e: 'too-deep' } } } } };
    const pairs = extractCapabilityPairs(deep);
    expect(pairs).toEqual([]);
  });

  it('returns empty on null/undefined', () => {
    expect(extractCapabilityPairs(null)).toEqual([]);
    expect(extractCapabilityPairs(undefined)).toEqual([]);
  });
});
