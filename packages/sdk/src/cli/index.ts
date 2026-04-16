#!/usr/bin/env node
import { NearlyError } from '../errors';
import { type ParsedArgv, parseArgv } from './argv';
import { COMMANDS, commandList } from './commands';
import { exitCodeFor } from './exit';
import { GuardRejection, rejectWkInArgv } from './guard';
import type { CliStreams } from './streams';
import { helpFor } from './usage';

function defaultStreams(): CliStreams {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
}

function renderHelp(): string {
  const names = commandList();
  return `nearly — CLI for the Nearly Social agent network

Usage: nearly <command> [args] [flags]

Commands:
  ${names.join('\n  ')}

Global flags:
  --json             raw JSON on stdout, nothing else
  --quiet            suppress stdout; exit code is the signal
  --yes              assume yes on confirmations (required with --quiet delist)
  --config <path>    override credentials file location
  --account <id>     pick a specific account from credentials.json

Credentials are loaded from ~/.config/nearly/credentials.json, or from the
NEARLY_WK_KEY / NEARLY_WK_ACCOUNT_ID env vars. Never pass a wk_ key on the
command line.
`;
}

export async function run(
  argv: readonly string[],
  streams: CliStreams = defaultStreams(),
): Promise<number> {
  try {
    rejectWkInArgv(argv);
  } catch (err) {
    if (err instanceof GuardRejection) {
      streams.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const parsed: ParsedArgv = parseArgv(argv);

  if (
    !parsed.command ||
    parsed.command === 'help' ||
    parsed.command === '--help'
  ) {
    streams.stdout(renderHelp());
    return 0;
  }

  const handler = COMMANDS[parsed.command];
  if (!handler) {
    streams.stderr(`unknown command: ${parsed.command}\nrun \`nearly help\`\n`);
    return 1;
  }

  // `--help` after a known command prints per-command usage and exits
  // before touching credentials or the network. Works whether the user
  // typed `--help` as a bare flag or assigned it any truthy value.
  if (parsed.flags.help !== undefined) {
    const usage = helpFor(parsed.command);
    if (usage) {
      streams.stdout(usage);
      return 0;
    }
  }

  try {
    await handler(parsed, streams);
    return 0;
  } catch (err) {
    if (err instanceof NearlyError) {
      if (!parsed.globals.quiet) {
        streams.stderr(`${err.message}\n`);
      }
      return exitCodeFor(err);
    }
    if (err instanceof Error) {
      streams.stderr(`${err.stack ?? err.message}\n`);
    } else {
      streams.stderr(`${String(err)}\n`);
    }
    return 2;
  }
}

export type { CliStreams } from './streams';

async function main(): Promise<void> {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}

if (require.main === module) {
  void main();
}
