import { validationError } from '../../errors';
import { type ParsedArgv, toArray } from '../argv';
import { buildClient } from '../client-factory';
import { EXIT_PARTIAL_BATCH } from '../exit';
import { renderKeyValue, renderOutput, renderRows } from '../format';
import type { CliStreams } from '../streams';

export async function unendorse(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly unendorse <accountId> [<accountId>...] --key-suffix X [--key-suffix Y]',
    );
  }

  const keySuffixes = toArray(parsed.flags['key-suffix']);
  if (keySuffixes.length === 0) {
    throw validationError(
      'key-suffix',
      'at least one --key-suffix is required',
    );
  }

  const client = await buildClient(parsed.globals);

  if (targets.length === 1) {
    const result = await client.unendorse(targets[0], keySuffixes);
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

  const results = await client.unendorseMany(
    targets.map((account_id) => ({ account_id, keySuffixes })),
  );
  renderOutput(
    parsed.globals,
    results,
    () =>
      renderRows(
        ['account_id', 'action', 'detail'],
        results.map((r) =>
          r.action === 'error'
            ? [r.account_id, 'error', `${r.code}: ${r.error}`]
            : [r.account_id, r.action, r.key_suffixes.join(', ')],
        ),
      ),
    streams,
  );
  return results.some((r) => r.action === 'error') ? EXIT_PARTIAL_BATCH : 0;
}
