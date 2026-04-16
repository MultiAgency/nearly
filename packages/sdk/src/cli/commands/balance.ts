import type { ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderJson, renderKeyValue } from '../format';
import type { CliStreams } from '../streams';

export async function balance(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const result = await client.getBalance();

  if (parsed.globals.quiet) return;
  if (parsed.globals.json) {
    streams.stdout(renderJson(result));
    return;
  }

  const rows: Array<[string, string]> = [
    ['account_id', result.accountId],
    ['chain', result.chain],
    ['balance_raw', result.balance],
  ];
  if (result.balanceNear !== undefined) {
    rows.push(['balance_near', String(result.balanceNear)]);
  }
  streams.stdout(renderKeyValue(rows));
}
