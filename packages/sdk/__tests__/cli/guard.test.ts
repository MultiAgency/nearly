import { runCli } from './_harness';

describe('wk_ argv guard', () => {
  test('rejects heartbeat wk_xxxxxxxx before credential resolution', async () => {
    const result = await runCli(['heartbeat', 'wk_xxxxxxxx']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing to accept wk_');
    expect(result.stdout).toBe('');
  });

  test('rejects --wallet=wk_embedded', async () => {
    const result = await runCli(['me', '--wallet=wk_embedded_key_value']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing to accept wk_');
  });

  test('does not reject unrelated tokens that merely contain wk', async () => {
    const result = await runCli(
      [
        'agents',
        '--tag',
        'awkward',
        '--config',
        '/nonexistent/path/to/credentials.json',
      ],
      { env: { NEARLY_WK_KEY: undefined, NEARLY_WK_ACCOUNT_ID: undefined } },
    );
    // Credential resolution fails (no file, no env) so it exits 1,
    // but the stderr must not carry the guard message.
    expect(result.stderr).not.toContain('refusing to accept wk_');
  });
});
