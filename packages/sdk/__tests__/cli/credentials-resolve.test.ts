import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCredentials } from '../../src/cli/credentials-resolve';
import { NearlyError } from '../../src/errors';

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-cli-'));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, contents);
  return path;
}

const EMPTY_ENV: Record<string, string | undefined> = {
  NEARLY_WK_KEY: undefined,
  NEARLY_WK_ACCOUNT_ID: undefined,
};

describe('resolveCredentials priority', () => {
  test('falls back to the dictionary key when entry has no account_id', async () => {
    // The production credentials file written by the frontend's Handoff
    // flow stores only `api_key` + `platforms` on each entry — the
    // account_id is the map key, not a field on the entry. resolveCredentials
    // must tolerate this.
    const path = tmpFile(
      JSON.stringify({
        accounts: {
          'alice.near': {
            api_key: 'wk_alice',
            platforms: { social: { handle: 'alice' } },
          },
        },
      }),
    );
    const result = await resolveCredentials({ config: path, env: EMPTY_ENV });
    expect(result).toEqual({ walletKey: 'wk_alice', accountId: 'alice.near' });
  });

  test('--account selects by dictionary key when entry has no account_id', async () => {
    const path = tmpFile(
      JSON.stringify({
        accounts: {
          'alice.near': { api_key: 'wk_alice' },
          'bob.near': { api_key: 'wk_bob' },
        },
      }),
    );
    const result = await resolveCredentials({
      config: path,
      account: 'bob.near',
      env: EMPTY_ENV,
    });
    expect(result).toEqual({ walletKey: 'wk_bob', accountId: 'bob.near' });
  });

  test('single account in file is used', async () => {
    const path = tmpFile(
      JSON.stringify({
        accounts: {
          'alice.near': { api_key: 'wk_alice', account_id: 'alice.near' },
        },
      }),
    );
    const result = await resolveCredentials({ config: path, env: EMPTY_ENV });
    expect(result).toEqual({ walletKey: 'wk_alice', accountId: 'alice.near' });
  });

  test('multi account requires --account', async () => {
    const path = tmpFile(
      JSON.stringify({
        accounts: {
          'alice.near': { api_key: 'wk_alice', account_id: 'alice.near' },
          'bob.near': { api_key: 'wk_bob', account_id: 'bob.near' },
        },
      }),
    );
    await expect(
      resolveCredentials({ config: path, env: EMPTY_ENV }),
    ).rejects.toMatchObject({ shape: { code: 'VALIDATION_ERROR' } });
  });

  test('--account flag selects specific entry', async () => {
    const path = tmpFile(
      JSON.stringify({
        accounts: {
          'alice.near': { api_key: 'wk_alice', account_id: 'alice.near' },
          'bob.near': { api_key: 'wk_bob', account_id: 'bob.near' },
        },
      }),
    );
    const result = await resolveCredentials({
      config: path,
      account: 'bob.near',
      env: EMPTY_ENV,
    });
    expect(result.accountId).toBe('bob.near');
    expect(result.walletKey).toBe('wk_bob');
  });

  test('--account with unknown id throws VALIDATION_ERROR', async () => {
    const path = tmpFile(JSON.stringify({ accounts: {} }));
    await expect(
      resolveCredentials({
        config: path,
        account: 'ghost.near',
        env: EMPTY_ENV,
      }),
    ).rejects.toBeInstanceOf(NearlyError);
  });

  test('env var pair overrides missing file', async () => {
    const result = await resolveCredentials({
      config: '/nonexistent/path',
      env: {
        NEARLY_WK_KEY: 'wk_env',
        NEARLY_WK_ACCOUNT_ID: 'env.near',
      },
    });
    expect(result).toEqual({ walletKey: 'wk_env', accountId: 'env.near' });
  });

  test('no file and no env exits with actionable message', async () => {
    await expect(
      resolveCredentials({ config: '/nonexistent/path', env: EMPTY_ENV }),
    ).rejects.toMatchObject({
      shape: {
        code: 'VALIDATION_ERROR',
        reason: expect.stringContaining('nearly register'),
      },
    });
  });
});
