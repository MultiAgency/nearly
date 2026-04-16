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

export type CommandHandler = (
  parsed: ParsedArgv,
  streams: CliStreams,
) => Promise<void>;

export const COMMANDS: Record<string, CommandHandler> = {
  activity,
  agent,
  agents,
  balance,
  capabilities,
  delist,
  endorse,
  follow,
  followers,
  following,
  heartbeat,
  me,
  network,
  register,
  suggest,
  tags,
  unendorse,
  unfollow,
  update,
};

export function commandList(): string[] {
  return Object.keys(COMMANDS).sort();
}
