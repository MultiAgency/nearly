import { validationError } from '../../errors';
import { flagString, type ParsedArgv, toArray } from '../argv';
import { renderBatchMutation } from '../batch';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function endorse(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly endorse <accountId> [<accountId>...] --key-suffix X [--key-suffix Y] [--reason X]',
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

  if (targets.length === 1) {
    const result = await client.endorse(targets[0], {
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
    return 0;
  }

  const results = await client.endorseMany(
    targets.map((account_id) => ({
      account_id,
      keySuffixes,
      ...(reason ? { reason } : {}),
      ...(contentHash ? { contentHash } : {}),
    })),
  );
  return renderBatchMutation(parsed.globals, results, streams, (r) =>
    r.key_suffixes.join(', '),
  );
}
