import { NearlyClient } from '../../src/client';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

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
    expect(result.stdout).toContain('unfollowed');
    expect(result.stdout).toContain('alice.near');
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

  test('no target exits 1 with usage', async () => {
    const path = tmpCreds(CREDS);
    const result = await runCli(['unfollow', '--config', path], NO_ENV);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage: nearly unfollow/);
  });
});
