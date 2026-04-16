import { validationError } from '../../errors';
import { flagString, type ParsedArgv, toArray } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function endorse(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const target = parsed.positional[0];
  if (!target) {
    throw validationError(
      'target',
      'usage: nearly endorse <accountId> --key-suffix X [--key-suffix Y] [--reason X]',
    );
  }

  const keySuffixes = toArray(parsed.flags['key-suffix']);
  if (keySuffixes.length === 0) {
    throw validationError(
      'key-suffix',
      'at least one --key-suffix is required',
    );
  }

  const reason = flagString(parsed.flags.reason);
  const contentHash = flagString(parsed.flags['content-hash']);

  const client = await buildClient(parsed.globals);
  const result = await client.endorse(target, {
    keySuffixes,
    ...(reason ? { reason } : {}),
    ...(contentHash ? { contentHash } : {}),
  });

  renderOutput(
    parsed.globals,
    result,
    () =>
      renderKeyValue([
        ['action', result.action],
        ['target', result.target],
        ['key_suffixes', result.key_suffixes.join(', ')],
      ]),
    streams,
  );
}
