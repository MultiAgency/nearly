import { flagNumber, type ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderJson, renderKeyValue, renderRows } from '../format';
import type { CliStreams } from '../streams';

export async function activity(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);
  const cursor = flagNumber(parsed.flags.cursor);
  const result = await client.getActivity(cursor ? { cursor } : {});

  if (parsed.globals.quiet) return;
  if (parsed.globals.json) {
    streams.stdout(renderJson(result));
    return;
  }

  streams.stdout(
    renderKeyValue([
      ['cursor', String(result.cursor ?? '-')],
      ['new_followers', String(result.new_followers.length)],
      ['new_following', String(result.new_following.length)],
    ]),
  );
  if (result.new_followers.length > 0) {
    streams.stdout('\nnew_followers:\n');
    streams.stdout(
      renderRows(
        ['account_id', 'name'],
        result.new_followers.map((s) => [s.account_id, s.name ?? '-']),
      ),
    );
  }
  if (result.new_following.length > 0) {
    streams.stdout('\nnew_following:\n');
    streams.stdout(
      renderRows(
        ['account_id', 'name'],
        result.new_following.map((s) => [s.account_id, s.name ?? '-']),
      ),
    );
  }
}
