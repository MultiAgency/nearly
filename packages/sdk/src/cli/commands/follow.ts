import { validationError } from '../../errors';
import { flagString, type ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function follow(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const target = parsed.positional[0];
  if (!target) {
    throw validationError(
      'target',
      'usage: nearly follow <accountId> [--reason X]',
    );
  }

  const client = await buildClient(parsed.globals);
  const reason = flagString(parsed.flags.reason);
  const result = await client.follow(target, reason ? { reason } : {});

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
