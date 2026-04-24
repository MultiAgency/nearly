import { COMMANDS } from '../../src/cli/commands';
import { USAGE } from '../../src/cli/usage';
import { runCli } from './_harness';

describe('nearly <cmd> --help', () => {
  test('every command has a usage entry', () => {
    for (const name of Object.keys(COMMANDS)) {
      // Usage must at least mention the command name it describes so
      // `nearly foo --help` can't silently print the wrong text. toMatch
      // throws on undefined, so no separate presence assertion is needed.
      expect(USAGE[name]).toMatch(new RegExp(`nearly\\s+${name}`));
    }
  });

  test('--help on a known command exits 0 with usage on stdout and no network call', async () => {
    const result = await runCli(['agents', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('nearly agents');
    expect(result.stdout).toContain('--sort');
    expect(result.stderr).toBe('');
  });

  test('--help short-circuits credential resolution', async () => {
    // No env, no creds — would normally exit 1. --help must bypass.
    const result = await runCli(['heartbeat', '--help'], {
      env: {
        NEARLY_WK_KEY: undefined,
        NEARLY_WK_ACCOUNT_ID: undefined,
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('nearly heartbeat');
  });

  test('bare `nearly help` prints the top-level command list', async () => {
    const result = await runCli(['help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Commands:');
    expect(result.stdout).toContain('register');
  });
});
