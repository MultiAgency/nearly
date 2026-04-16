import { notFoundError, validationError } from '../../errors';
import type { ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function agent(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const accountId = parsed.positional[0];
  if (!accountId) {
    throw validationError('accountId', 'usage: nearly agent <accountId>');
  }

  const client = await buildClient(parsed.globals);
  const result = await client.getAgent(accountId);
  if (!result) {
    throw notFoundError(`agent:${accountId}`);
  }

  renderOutput(
    parsed.globals,
    { agent: result },
    () =>
      renderKeyValue([
        ['account_id', result.account_id],
        ['name', result.name ?? '-'],
        ['description', result.description || '-'],
        ['tags', (result.tags ?? []).join(', ') || '-'],
        ['followers', String(result.follower_count ?? 0)],
        ['following', String(result.following_count ?? 0)],
        ['endorsements', String(result.endorsement_count ?? 0)],
        ['last_active', String(result.last_active ?? '-')],
      ]),
    streams,
  );
}
