import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NearlyClient } from '../../src/client';
import { runCli } from './_harness';

function tmpCreds(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-unfollow-'));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const CREDS = {
  accounts: {
    'caller.near': {
      api_key: 'wk_caller_test_key',
      account_id: 'caller.near',
    },
  },
};

const NO_ENV = {
  env: {
    NEARLY_WK_KEY: undefined,
    NEARLY_WK_ACCOUNT_ID: undefined,
  },
};

describe('nearly unfollow', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('single target renders action/target, exits 0', async () => {
    const path = tmpCreds(CREDS);
    const unfollowSpy = jest
      .spyOn(NearlyClient.prototype, 'unfollow')
      .mockResolvedValue({ action: 'unfollowed', target: 'alice.near' });
    const batchSpy = jest.spyOn(NearlyClient.prototype, 'unfollowMany');

    const result = await runCli(
      ['unfollow', 'alice.near', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(unfollowSpy).toHaveBeenCalledWith('alice.near');
    expect(batchSpy).not.toHaveBeenCalled();
    expect(result.stdout).toBe('action  unfollowed\ntarget  alice.near\n');
  });

  test('multiple targets success exits 0', async () => {
    const path = tmpCreds(CREDS);
    jest.spyOn(NearlyClient.prototype, 'unfollowMany').mockResolvedValue([
      { account_id: 'alice.near', action: 'unfollowed', target: 'alice.near' },
      { account_id: 'bob.near', action: 'not_following', target: 'bob.near' },
    ]);

    const result = await runCli(
      ['unfollow', 'alice.near', 'bob.near', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('unfollowed');
    expect(result.stdout).toContain('not_following');
  });

  test('per-item error exits 4', async () => {
    const path = tmpCreds(CREDS);
    jest.spyOn(NearlyClient.prototype, 'unfollowMany').mockResolvedValue([
      { account_id: 'alice.near', action: 'unfollowed', target: 'alice.near' },
      {
        account_id: 'bob.near',
        action: 'error',
        code: 'STORAGE_ERROR',
        error: 'read failed',
      },
    ]);

    const result = await runCli(
      ['unfollow', 'alice.near', 'bob.near', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(4);
    expect(result.stdout).toContain('STORAGE_ERROR: read failed');
  });

  test('no target exits 1 with usage', async () => {
    const path = tmpCreds(CREDS);
    const result = await runCli(['unfollow', '--config', path], NO_ENV);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage: nearly unfollow/);
  });
});
