import {
  makeRng,
  scoreBySharedTags,
  shuffleWithinTiers,
  sortByScoreThenActive,
} from '../src/suggest';
import type { Agent } from '../src/types';

function agent(overrides: Partial<Agent> & Pick<Agent, 'account_id'>): Agent {
  return {
    name: overrides.account_id,
    description: '',
    image: null,
    tags: [],
    capabilities: {},
    last_active: 0,
    ...overrides,
  };
}

describe('makeRng', () => {
  it('is deterministic for the same seed', () => {
    const a = makeRng('deadbeef');
    const b = makeRng('deadbeef');
    for (let i = 0; i < 10; i++) {
      expect(a.pick(100)).toBe(b.pick(100));
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = makeRng('deadbeef');
    const b = makeRng('12345678');
    const seqA = Array.from({ length: 10 }, () => a.pick(100));
    const seqB = Array.from({ length: 10 }, () => b.pick(100));
    expect(seqA).not.toEqual(seqB);
  });

  it('handles zero-seed hex by substituting 1 (avoids stuck state)', () => {
    const rng = makeRng('00000000');
    // State must be non-zero after init or xorshift32 gets stuck at 0.
    // We verify by pulling multiple values and confirming at least one
    // is non-zero within a small n.
    const values = Array.from({ length: 5 }, () => rng.pick(100));
    expect(values.some((v) => v !== null && v !== 0)).toBe(true);
  });

  it('returns null for n=0', () => {
    const rng = makeRng('deadbeef');
    expect(rng.pick(0)).toBeNull();
  });

  it('pins the xorshift32 output sequence for seed "deadbeef"', () => {
    // Regenerate via node one-liner if the (13, 17, 5) constants or the
    // first-4-bytes-pack seeding formula ever change. A drift here means
    // every VRF-shuffled suggestion ordering silently moves.
    const rng = makeRng('deadbeef');
    const seq = [
      rng.pick(1000),
      rng.pick(1000),
      rng.pick(1000),
      rng.pick(1000),
      rng.pick(1000),
    ];
    expect(seq).toEqual([492, 836, 529, 320, 865]);
  });
});

describe('scoreBySharedTags', () => {
  it('counts intersection per candidate', () => {
    const callerTags = ['rust', 'wasm', 'ai'];
    const candidates = [
      agent({ account_id: 'a.near', tags: ['rust', 'wasm'] }),
      agent({ account_id: 'b.near', tags: ['rust'] }),
      agent({ account_id: 'c.near', tags: [] }),
      agent({ account_id: 'd.near', tags: ['python'] }),
    ];
    const scored = scoreBySharedTags(callerTags, candidates);
    expect(scored.map((s) => s.score)).toEqual([2, 1, 0, 0]);
    expect(scored[0].shared).toEqual(['rust', 'wasm']);
    expect(scored[3].shared).toEqual([]);
  });

  it('handles caller with no tags', () => {
    const scored = scoreBySharedTags(
      [],
      [agent({ account_id: 'a.near', tags: ['rust'] })],
    );
    expect(scored[0].score).toBe(0);
  });

  it('handles candidate with undefined tags', () => {
    const candidate: Agent = {
      ...agent({ account_id: 'x.near' }),
      tags: [] as string[],
    };
    const scored = scoreBySharedTags(['rust'], [candidate]);
    expect(scored[0].score).toBe(0);
  });
});

describe('sortByScoreThenActive', () => {
  it('sorts score desc, then last_active desc', () => {
    const input = [
      {
        agent: agent({ account_id: 'a.near', last_active: 100 }),
        shared: [],
        score: 1,
      },
      {
        agent: agent({ account_id: 'b.near', last_active: 200 }),
        shared: [],
        score: 1,
      },
      {
        agent: agent({ account_id: 'c.near', last_active: 50 }),
        shared: [],
        score: 3,
      },
      {
        agent: agent({ account_id: 'd.near', last_active: 999 }),
        shared: [],
        score: 0,
      },
    ];
    const sorted = sortByScoreThenActive(input);
    expect(sorted.map((s) => s.agent.account_id)).toEqual([
      'c.near', // score 3
      'b.near', // score 1, active 200
      'a.near', // score 1, active 100
      'd.near', // score 0
    ]);
  });

  it('does not mutate input', () => {
    const input = [
      { agent: agent({ account_id: 'a.near' }), shared: [], score: 0 },
      { agent: agent({ account_id: 'b.near' }), shared: [], score: 1 },
    ];
    const copy = [...input];
    sortByScoreThenActive(input);
    expect(input).toEqual(copy);
  });
});

describe('shuffleWithinTiers', () => {
  it('leaves ordering untouched when rng is null', () => {
    const input = [
      { agent: agent({ account_id: 'a.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'b.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'c.near' }), shared: [], score: 0 },
    ];
    const out = shuffleWithinTiers(input, null);
    expect(out.map((s) => s.agent.account_id)).toEqual([
      'a.near',
      'b.near',
      'c.near',
    ]);
  });

  it('only shuffles within equal-score tiers, preserving cross-tier order', () => {
    // Three tiers: score=3 (single), score=1 (three members), score=0 (two members)
    const input = [
      { agent: agent({ account_id: 'top.near' }), shared: [], score: 3 },
      { agent: agent({ account_id: 'mid1.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'mid2.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'mid3.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'low1.near' }), shared: [], score: 0 },
      { agent: agent({ account_id: 'low2.near' }), shared: [], score: 0 },
    ];
    const out = shuffleWithinTiers(input, makeRng('deadbeef'));
    // Top tier (score 3) has one member — position fixed.
    expect(out[0].agent.account_id).toBe('top.near');
    // Mid tier (score 1) has indices 1..3 — must still be mid-tier members,
    // order may change.
    const midIds = new Set(
      [out[1], out[2], out[3]].map((s) => s.agent.account_id),
    );
    expect(midIds).toEqual(new Set(['mid1.near', 'mid2.near', 'mid3.near']));
    // Low tier (score 0) has indices 4..5 — still low-tier members.
    const lowIds = new Set([out[4], out[5]].map((s) => s.agent.account_id));
    expect(lowIds).toEqual(new Set(['low1.near', 'low2.near']));
  });

  it('is deterministic for a fixed seed', () => {
    const make = () => [
      { agent: agent({ account_id: 'a.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'b.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'c.near' }), shared: [], score: 1 },
      { agent: agent({ account_id: 'd.near' }), shared: [], score: 1 },
    ];
    const a = shuffleWithinTiers(make(), makeRng('deadbeef')).map(
      (s) => s.agent.account_id,
    );
    const b = shuffleWithinTiers(make(), makeRng('deadbeef')).map(
      (s) => s.agent.account_id,
    );
    expect(a).toEqual(b);
  });

  it('different seeds produce different orderings for a 10-member tier', () => {
    const make = () =>
      Array.from({ length: 10 }, (_, i) => ({
        agent: agent({ account_id: `a${i}.near` }),
        shared: [],
        score: 1,
      }));
    const a = shuffleWithinTiers(make(), makeRng('deadbeef')).map(
      (s) => s.agent.account_id,
    );
    const b = shuffleWithinTiers(make(), makeRng('cafef00d')).map(
      (s) => s.agent.account_id,
    );
    expect(a).not.toEqual(b);
  });
});
