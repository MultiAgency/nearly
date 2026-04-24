import { NearlyClient } from '../../src/client';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

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
    expect(result.stdout).toContain('endorsed');
    expect(result.stdout).toContain('alice.near');
    expect(result.stdout).toContain('tags/rust');
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
