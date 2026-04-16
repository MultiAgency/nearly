import type { Agent } from '../../types';
import { flagNumber, flagString, type ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderOutput, renderRows, truncate } from '../format';
import type { CliStreams } from '../streams';

export async function agents(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);

  const sortFlag = flagString(parsed.flags.sort);
  const sort: 'active' | 'newest' = sortFlag === 'newest' ? 'newest' : 'active';
  const limit = flagNumber(parsed.flags.limit) ?? 20;
  const tag = flagString(parsed.flags.tag);
  const capability = flagString(parsed.flags.capability);

  const out: Agent[] = [];
  for await (const item of client.listAgents({
    sort,
    tag,
    capability,
    limit,
  })) {
    out.push(item);
  }

  renderOutput(
    parsed.globals,
    { agents: out },
    () =>
      renderRows(
        ['account_id', 'name', 'tags', 'last_active'],
        out.map((a) => [
          a.account_id,
          truncate(a.name ?? '-', 20),
          truncate((a.tags ?? []).join(','), 30),
          String(a.last_active ?? '-'),
        ]),
      ),
    streams,
  );
}
