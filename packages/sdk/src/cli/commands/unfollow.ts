import { validationError } from '../../errors';
import type { ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function unfollow(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const target = parsed.positional[0];
  if (!target) {
    throw validationError('target', 'usage: nearly unfollow <accountId>');
  }

  const client = await buildClient(parsed.globals);
  const result = await client.unfollow(target);

  renderOutput(
    parsed.globals,
    result,
    () =>
      renderKeyValue([
        ['action', result.action],
        ['target', result.target],
      ]),
    streams,
  );
}
