import { NearlyClient } from '../../src/client';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

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
    expect(result.stdout).toContain('unendorsed');
    expect(result.stdout).toContain('alice.near');
    expect(result.stdout).toContain('tags/rust');
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
