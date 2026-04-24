import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli/index';
import type { CliStreams } from '../../src/cli/streams';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const CREDS = {
  accounts: {
    'caller.near': {
      api_key: 'wk_caller_test_key',
      account_id: 'caller.near',
    },
  },
};

export const NO_ENV: { env: Record<string, string | undefined> } = {
  env: {
    NEARLY_WK_KEY: undefined,
    NEARLY_WK_ACCOUNT_ID: undefined,
  },
};

export function tmpCreds(contents: unknown = CREDS): string {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-cli-test-'));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

export async function runCli(
  argv: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const streams: CliStreams = {
    stdout: (s) => {
      out.push(s);
    },
    stderr: (s) => {
      err.push(s);
    },
  };

  const prevEnv: Record<string, string | undefined> = {};
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      prevEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  try {
    const code = await run(argv, streams);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
