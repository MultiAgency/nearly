import { validationError } from '../../errors';
import type { ParsedArgv } from '../argv';
import { renderBatchMutation } from '../batch';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function unfollow(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly unfollow <accountId> [<accountId>...]',
    );
  }

  const client = await buildClient(parsed.globals);

  if (targets.length === 1) {
    const result = await client.unfollow(targets[0]);
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
    return 0;
  }

  const results = await client.unfollowMany(targets);
  return renderBatchMutation(parsed.globals, results, streams, () => '');
}
