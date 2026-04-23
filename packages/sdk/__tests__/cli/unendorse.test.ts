import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NearlyClient } from '../../src/client';
import { runCli } from './_harness';

function tmpCreds(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-unendorse-'));
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

describe('nearly unendorse', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('single target renders action/target/key_suffixes, exits 0', async () => {
    const path = tmpCreds(CREDS);
    const unendorseSpy = jest
      .spyOn(NearlyClient.prototype, 'unendorse')
      .mockResolvedValue({
        action: 'unendorsed',
        target: 'alice.near',
        key_suffixes: ['tags/rust'],
      });
    const batchSpy = jest.spyOn(NearlyClient.prototype, 'unendorseMany');

    const result = await runCli(
      [
        'unendorse',
        'alice.near',
        '--key-suffix',
        'tags/rust',
        '--config',
        path,
      ],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(unendorseSpy).toHaveBeenCalledWith('alice.near', ['tags/rust']);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(result.stdout).toBe(
      'action        unendorsed\ntarget        alice.near\nkey_suffixes  tags/rust\n',
    );
  });

  test('multi target applies homogeneous key-suffix list via unendorseMany', async () => {
    const path = tmpCreds(CREDS);
    const batchSpy = jest
      .spyOn(NearlyClient.prototype, 'unendorseMany')
      .mockResolvedValue([
        {
          account_id: 'alice.near',
          action: 'unendorsed',
          target: 'alice.near',
          key_suffixes: ['tags/rust'],
        },
        {
          account_id: 'bob.near',
          action: 'unendorsed',
          target: 'bob.near',
          key_suffixes: ['tags/rust'],
        },
      ]);

    const result = await runCli(
      [
        'unendorse',
        'alice.near',
        'bob.near',
        '--key-suffix',
        'tags/rust',
        '--config',
        path,
      ],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(batchSpy).toHaveBeenCalledWith([
      { account_id: 'alice.near', keySuffixes: ['tags/rust'] },
      { account_id: 'bob.near', keySuffixes: ['tags/rust'] },
    ]);
  });

  test('per-item error exits 4', async () => {
    const path = tmpCreds(CREDS);
    jest.spyOn(NearlyClient.prototype, 'unendorseMany').mockResolvedValue([
      {
        account_id: 'alice.near',
        action: 'unendorsed',
        target: 'alice.near',
        key_suffixes: ['tags/rust'],
      },
      {
        account_id: 'caller.near',
        action: 'error',
        code: 'SELF_UNENDORSE',
        error: 'cannot unendorse yourself',
      },
    ]);

    const result = await runCli(
      [
        'unendorse',
        'alice.near',
        'caller.near',
        '--key-suffix',
        'tags/rust',
        '--config',
        path,
      ],
      NO_ENV,
    );

    expect(result.code).toBe(4);
    expect(result.stdout).toContain(
      'SELF_UNENDORSE: cannot unendorse yourself',
    );
  });

  test('missing --key-suffix exits 1', async () => {
    const path = tmpCreds(CREDS);
    const result = await runCli(
      ['unendorse', 'alice.near', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/at least one --key-suffix is required/);
  });
});
