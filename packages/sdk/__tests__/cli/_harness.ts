import { run } from '../../src/cli/index';
import type { CliStreams } from '../../src/cli/streams';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
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
