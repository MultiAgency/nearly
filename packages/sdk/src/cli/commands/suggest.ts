import { flagNumber, type ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderJson, renderRows, truncate } from '../format';
import type { CliStreams } from '../streams';

export async function suggest(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const limit = flagNumber(parsed.flags.limit) ?? 10;
  const result = await client.getSuggested({ limit });

  if (parsed.globals.quiet) return;
  if (parsed.globals.json) {
    streams.stdout(renderJson(result));
    return;
  }
  streams.stdout(
    renderRows(
      ['account_id', 'name', 'reason'],
      result.agents.map((a) => [
        a.account_id,
        truncate(a.name ?? '-', 20),
        truncate(a.reason ?? '-', 40),
      ]),
    ),
  );
  if (!result.vrf) {
    const reason = result.vrfError
      ? `${result.vrfError.code}: ${result.vrfError.message}`
      : 'unknown';
    streams.stderr(`(VRF unavailable: ${reason} — deterministic ranking)\n`);
  }
}
