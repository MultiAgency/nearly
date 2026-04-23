import { buildKvDelete, buildKvPut } from '../src/kv';

describe('buildKvPut', () => {
  it('returns correct action and entries', () => {
    const m = buildKvPut('alice.near', 'hidden/bob.near', true);
    expect(m.action).toBe('kv.put');
    expect(m.entries).toEqual({ 'hidden/bob.near': true });
    expect(m.rateLimitKey).toBe('alice.near');
  });

  it('passes non-boolean values through unchanged (reference-identical)', () => {
    // Production only uses boolean hide markers today, but the builder's
    // contract is "pass value straight into entries." This pins that — any
    // future serialization/copy would surface here before shipping.
    const value = { nested: 'value', arr: [1, 2] };
    const m = buildKvPut('alice.near', 'data/key', value);
    expect(m.entries['data/key']).toBe(value);
  });

  it('throws VALIDATION_ERROR on empty key', () => {
    expect(() => buildKvPut('alice.near', '', true)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});

describe('buildKvDelete', () => {
  it('returns correct action with null value', () => {
    const m = buildKvDelete('alice.near', 'hidden/bob.near');
    expect(m.action).toBe('kv.delete');
    expect(m.entries).toEqual({ 'hidden/bob.near': null });
    expect(m.rateLimitKey).toBe('alice.near');
  });

  it('throws VALIDATION_ERROR on empty key', () => {
    expect(() => buildKvDelete('alice.near', '')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});
