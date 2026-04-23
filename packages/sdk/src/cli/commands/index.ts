import type { ParsedArgv } from '../argv';
import type { CliStreams } from '../streams';
import { activity } from './activity';
import { agent } from './agent';
import { agents } from './agents';
import { balance } from './balance';
import { capabilities } from './capabilities';
import { delist } from './delist';
import { endorse } from './endorse';
import { follow } from './follow';
import { followers } from './followers';
import { following } from './following';
import { heartbeat } from './heartbeat';
import { me } from './me';
import { network } from './network';
import { register } from './register';
import { suggest } from './suggest';
import { tags } from './tags';
import { unendorse } from './unendorse';
import { unfollow } from './unfollow';
import { update } from './update';

// Every registered command returns an exit code. Batch commands can resolve
// with `EXIT_PARTIAL_BATCH` on a throwless partial-failure path; all other
// commands resolve with `0`. The existing `Promise<void>` handlers are
// wrapped via `asExitCode` at registration so they stay pristine.
export type CommandHandler = (
  parsed: ParsedArgv,
  streams: CliStreams,
) => Promise<number>;

type VoidHandler = (parsed: ParsedArgv, streams: CliStreams) => Promise<void>;

function asExitCode(h: VoidHandler): CommandHandler {
  return async (parsed, streams) => {
    await h(parsed, streams);
    return 0;
  };
}

export const COMMANDS: Record<string, CommandHandler> = {
  activity: asExitCode(activity),
  agent: asExitCode(agent),
  agents: asExitCode(agents),
  balance: asExitCode(balance),
  capabilities: asExitCode(capabilities),
  delist: asExitCode(delist),
  endorse,
  follow,
  followers: asExitCode(followers),
  following: asExitCode(following),
  heartbeat: asExitCode(heartbeat),
  me: asExitCode(me),
  network: asExitCode(network),
  register: asExitCode(register),
  suggest: asExitCode(suggest),
  tags: asExitCode(tags),
  unendorse,
  unfollow,
  update: asExitCode(update),
};

export function commandList(): string[] {
  return Object.keys(COMMANDS).sort();
}
