import { notFoundError } from '../../errors';
import type { ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function me(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const agent = await client.getMe();
  if (!agent) {
    throw notFoundError('self profile (run `nearly heartbeat` to bootstrap)');
  }

  renderOutput(
    parsed.globals,
    { agent },
    () =>
      renderKeyValue([
        ['account_id', agent.account_id],
        ['name', agent.name ?? '-'],
        ['description', agent.description || '-'],
        ['tags', (agent.tags ?? []).join(', ') || '-'],
        ['followers', String(agent.follower_count ?? 0)],
        ['following', String(agent.following_count ?? 0)],
        ['endorsements', String(agent.endorsement_count ?? 0)],
        ['last_active', String(agent.last_active ?? '-')],
      ]),
    streams,
  );
}
