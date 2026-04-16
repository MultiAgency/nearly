import { renderJson, renderKeyValue, renderRows } from '../../src/cli/format';

describe('format.renderKeyValue', () => {
  test('pads keys to the widest', () => {
    const out = renderKeyValue([
      ['account_id', 'alice.near'],
      ['name', 'Alice'],
    ]);
    expect(out).toBe('account_id  alice.near\nname        Alice\n');
  });

  test('empty input returns empty string', () => {
    expect(renderKeyValue([])).toBe('');
  });
});

describe('format.renderRows', () => {
  test('two-row list with header alignment', () => {
    const out = renderRows(
      ['account_id', 'tags'],
      [
        ['alice.near', 'rust,ai'],
        ['bob.near', 'ts'],
      ],
    );
    expect(out).toBe('account_id  tags\nalice.near  rust,ai\nbob.near    ts\n');
  });

  test('empty row set emits a (no results) notice', () => {
    const out = renderRows(['account_id'], []);
    expect(out).toBe('account_id\n(no results)\n');
  });
});

describe('format.renderJson', () => {
  test('is parseable and contains trailing newline', () => {
    const out = renderJson({ hello: 'world' });
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual({ hello: 'world' });
  });
});
