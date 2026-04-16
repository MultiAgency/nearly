import type { CapabilityCount } from '../../types';
import { flagNumber, type ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderOutput, renderRows } from '../format';
import type { CliStreams } from '../streams';

export async function capabilities(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const limit = flagNumber(parsed.flags.limit) ?? 50;

  const out: CapabilityCount[] = [];
  for await (const c of client.listCapabilities()) {
    if (out.length >= limit) break;
    out.push(c);
  }

  renderOutput(
    parsed.globals,
    { capabilities: out },
    () =>
      renderRows(
        ['namespace', 'value', 'count'],
        out.map((c) => [c.namespace, c.value, String(c.count)]),
      ),
    streams,
  );
}
