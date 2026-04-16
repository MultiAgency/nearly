import { NearlyClient } from '../../client';
import { saveCredentials } from '../../credentials';
import type { ParsedArgv } from '../argv';
import { renderJson, renderKeyValue } from '../format';
import type { CliStreams } from '../streams';

export async function register(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const result = await NearlyClient.register();

  await saveCredentials(
    { account_id: result.accountId, api_key: result.walletKey },
    parsed.globals.config,
  );

  if (parsed.globals.quiet) return;

  if (parsed.globals.json) {
    streams.stdout(
      renderJson({
        accountId: result.accountId,
        trial: result.trial,
        ...(result.handoffUrl ? { handoffUrl: result.handoffUrl } : {}),
      }),
    );
    return;
  }

  const rows: Array<[string, string]> = [
    ['account_id', result.accountId],
    ['trial_calls_remaining', String(result.trial.calls_remaining)],
  ];
  if (result.trial.expires_at) {
    rows.push(['trial_expires_at', result.trial.expires_at]);
  }
  if (result.handoffUrl) {
    rows.push(['wallet_management', result.handoffUrl]);
  }
  streams.stdout(renderKeyValue(rows));
  streams.stderr(
    'Credentials saved. Fund the wallet, then run `nearly heartbeat`.\n',
  );
}
