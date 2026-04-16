import type { ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function heartbeat(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const { agent } = await client.heartbeat();

  renderOutput(
    parsed.globals,
    { agent },
    () =>
      renderKeyValue([
        ['account_id', agent.account_id],
        ['name', agent.name ?? '-'],
        ['tags', (agent.tags ?? []).join(', ') || '-'],
        ['last_active', String(agent.last_active ?? '-')],
      ]),
    streams,
  );
}
