import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NearlyClient } from '../../src/client';
import { runCli } from './_harness';

function tmpCreds(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-endorse-'));
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

describe('nearly endorse', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('single target renders action/target/key_suffixes, exits 0', async () => {
    const path = tmpCreds(CREDS);
    const endorseSpy = jest
      .spyOn(NearlyClient.prototype, 'endorse')
      .mockResolvedValue({
        action: 'endorsed',
        target: 'alice.near',
        key_suffixes: ['tags/rust'],
      });
    const batchSpy = jest.spyOn(NearlyClient.prototype, 'endorseMany');

    const result = await runCli(
      ['endorse', 'alice.near', '--key-suffix', 'tags/rust', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(endorseSpy).toHaveBeenCalledWith('alice.near', {
      keySuffixes: ['tags/rust'],
    });
    expect(batchSpy).not.toHaveBeenCalled();
    expect(result.stdout).toBe(
      'action        endorsed\ntarget        alice.near\nkey_suffixes  tags/rust\n',
    );
  });

  test('multi target applies homogeneous key-suffix list via endorseMany', async () => {
    const path = tmpCreds(CREDS);
    const batchSpy = jest
      .spyOn(NearlyClient.prototype, 'endorseMany')
      .mockResolvedValue([
        {
          account_id: 'alice.near',
          action: 'endorsed',
          target: 'alice.near',
          key_suffixes: ['tags/rust', 'skills/audit'],
        },
        {
          account_id: 'bob.near',
          action: 'endorsed',
          target: 'bob.near',
          key_suffixes: ['tags/rust', 'skills/audit'],
        },
      ]);

    const result = await runCli(
      [
        'endorse',
        'alice.near',
        'bob.near',
        '--key-suffix',
        'tags/rust',
        '--key-suffix',
        'skills/audit',
        '--config',
        path,
      ],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(batchSpy).toHaveBeenCalledWith([
      { account_id: 'alice.near', keySuffixes: ['tags/rust', 'skills/audit'] },
      { account_id: 'bob.near', keySuffixes: ['tags/rust', 'skills/audit'] },
    ]);
    expect(result.stdout).toContain('tags/rust, skills/audit');
  });

  test('per-item error exits 4', async () => {
    const path = tmpCreds(CREDS);
    jest.spyOn(NearlyClient.prototype, 'endorseMany').mockResolvedValue([
      {
        account_id: 'alice.near',
        action: 'endorsed',
        target: 'alice.near',
        key_suffixes: ['tags/rust'],
      },
      {
        account_id: 'ghost.near',
        action: 'error',
        code: 'NOT_FOUND',
        error: 'agent not found: ghost.near',
      },
    ]);

    const result = await runCli(
      [
        'endorse',
        'alice.near',
        'ghost.near',
        '--key-suffix',
        'tags/rust',
        '--config',
        path,
      ],
      NO_ENV,
    );

    expect(result.code).toBe(4);
    expect(result.stdout).toContain('NOT_FOUND: agent not found: ghost.near');
  });

  test('missing --key-suffix exits 1 regardless of target count', async () => {
    const path = tmpCreds(CREDS);
    const result = await runCli(
      ['endorse', 'alice.near', 'bob.near', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/at least one --key-suffix is required/);
  });

  test('no target exits 1 with usage', async () => {
    const path = tmpCreds(CREDS);
    const result = await runCli(['endorse', '--config', path], NO_ENV);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage: nearly endorse/);
  });
});
