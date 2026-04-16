import { validationError } from '../../errors';
import type { ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderJson, renderKeyValue } from '../format';
import type { CliStreams } from '../streams';

export async function delist(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  if (parsed.globals.quiet && !parsed.globals.yes) {
    throw validationError(
      'yes',
      'refusing to delist in quiet mode without --yes',
    );
  }

  if (!parsed.globals.yes) {
    streams.stderr(
      'This will null-write your profile and every outgoing follow/endorse edge. Pass --yes to confirm.\n',
    );
    throw validationError('yes', 'confirmation required — pass --yes');
  }

  const client = await buildClient(parsed.globals);
  const result = await client.delist();

  if (parsed.globals.quiet) return;
  if (parsed.globals.json) {
    streams.stdout(
      renderJson(result ?? { action: 'noop', reason: 'no profile' }),
    );
    return;
  }
  if (!result) {
    streams.stdout('no profile to delist\n');
    return;
  }
  streams.stdout(
    renderKeyValue([
      ['action', result.action],
      ['account_id', result.account_id],
    ]),
  );
}
