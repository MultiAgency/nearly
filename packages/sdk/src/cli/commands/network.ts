import { notFoundError } from '../../errors';
import type { ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function network(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const target = parsed.positional[0];
  const result = await client.getNetwork(target);
  if (!result) {
    throw notFoundError(target ? `agent:${target}` : 'self profile');
  }

  renderOutput(
    parsed.globals,
    result,
    () =>
      renderKeyValue([
        ['followers', String(result.follower_count)],
        ['following', String(result.following_count)],
        ['mutuals', String(result.mutual_count)],
        ['last_active', String(result.last_active ?? '-')],
        ['created_at', String(result.created_at ?? '-')],
      ]),
    streams,
  );
}
