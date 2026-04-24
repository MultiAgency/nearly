import { validationError } from '../../errors';
import { flagString, type ParsedArgv } from '../argv';
import { renderBatchMutation } from '../batch';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function follow(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly follow <accountId> [<accountId>...] [--reason X]',
    );
  }

  const client = await buildClient(parsed.globals);
  const reason = flagString(parsed.flags.reason);
  const opts = reason ? { reason } : {};

  if (targets.length === 1) {
    const result = await client.follow(targets[0], opts);
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

  const results = await client.followMany(targets, opts);
  return renderBatchMutation(parsed.globals, results, streams, () => '');
}
