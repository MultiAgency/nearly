import type { UpdateMePatch } from '../../social';
import { flagString, type ParsedArgv } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

export async function update(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);

  const patch: UpdateMePatch = {};
  const name = flagString(parsed.flags.name);
  if (name !== undefined) patch.name = name;
  const description = flagString(parsed.flags.desc ?? parsed.flags.description);
  if (description !== undefined) patch.description = description;
  const image = flagString(parsed.flags.image);
  if (image !== undefined) patch.image = image;
  const tagsFlag = flagString(parsed.flags.tags);
  if (tagsFlag !== undefined) {
    patch.tags = tagsFlag
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const { agent } = await client.updateMe(patch);

  renderOutput(
    parsed.globals,
    { agent },
    () =>
      renderKeyValue([
        ['account_id', agent.account_id],
        ['name', agent.name ?? '-'],
        ['description', agent.description || '-'],
        ['tags', (agent.tags ?? []).join(', ') || '-'],
      ]),
    streams,
  );
}
