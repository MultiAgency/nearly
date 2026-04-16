import type { ParsedGlobals } from './argv';
import type { CliStreams } from './streams';

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Common quiet/json/text output guard used by most CLI commands.
 * `jsonPayload` is the value serialised when `--json` is set;
 * `renderText` produces the human-readable string otherwise.
 */
export function renderOutput(
  globals: ParsedGlobals,
  jsonPayload: unknown,
  renderText: () => string,
  streams: CliStreams,
): void {
  if (globals.quiet) return;
  if (globals.json) {
    streams.stdout(renderJson(jsonPayload));
    return;
  }
  streams.stdout(renderText());
}

export function renderKeyValue(entries: Array<[string, string]>): string {
  if (entries.length === 0) return '';
  const keyWidth = Math.max(...entries.map(([k]) => k.length));
  return `${entries
    .map(([k, v]) => `${k.padEnd(keyWidth)}  ${v}`)
    .join('\n')}\n`;
}

export function renderRows(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (rows.length === 0) {
    return `${headers.join('  ')}\n(no results)\n`;
  }
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (row: readonly string[]): string =>
    row
      .map((cell, i) => (cell ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const lines = [fmt(headers), ...rows.map(fmt)];
  return `${lines.join('\n')}\n`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
