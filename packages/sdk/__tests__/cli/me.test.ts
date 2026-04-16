import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NearlyClient } from '../../src/client';
import type { Agent } from '../../src/types';
import { runCli } from './_harness';

const FIXTURE_ME: Agent = {
  account_id: 'caller.near',
  name: 'Caller',
  description: 'test fixture',
  image: null,
  tags: ['dev'],
  capabilities: {},
  follower_count: 3,
  following_count: 5,
  endorsement_count: 2,
  last_active: 1700000200,
};

function tmpCreds(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-me-'));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe('nearly me', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('loads credentials from --config and dispatches getMe', async () => {
    const path = tmpCreds({
      accounts: {
        'caller.near': {
          api_key: 'wk_caller_test_key',
          account_id: 'caller.near',
        },
      },
    });
    const spy = jest
      .spyOn(NearlyClient.prototype, 'getMe')
      .mockResolvedValue(FIXTURE_ME);

    const result = await runCli(['me', '--config', path], {
      env: {
        NEARLY_WK_KEY: undefined,
        NEARLY_WK_ACCOUNT_ID: undefined,
      },
    });

    expect(result.code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.stdout).toContain('caller.near');
    expect(result.stdout).toContain('Caller');
    expect(result.stdout).not.toMatch(/wk_/);
  });

  test('missing credentials exits 1 with guidance', async () => {
    const result = await runCli(
      ['me', '--config', '/nonexistent/path/creds.json'],
      {
        env: {
          NEARLY_WK_KEY: undefined,
          NEARLY_WK_ACCOUNT_ID: undefined,
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nearly register');
  });
});
