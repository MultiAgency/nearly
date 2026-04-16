import type { TagCount } from '../../types';
import { flagNumber, type ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderOutput, renderRows } from '../format';
import type { CliStreams } from '../streams';

export async function tags(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const limit = flagNumber(parsed.flags.limit) ?? 50;

  const out: TagCount[] = [];
  for await (const t of client.listTags()) {
    if (out.length >= limit) break;
    out.push(t);
  }

  renderOutput(
    parsed.globals,
    { tags: out },
    () =>
      renderRows(
        ['tag', 'count'],
        out.map((t) => [t.tag, String(t.count)]),
      ),
    streams,
  );
}
