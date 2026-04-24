import { type BatchFollowItem, NearlyClient } from '../../src/client';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

describe('nearly follow', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('single target: renders action/target, exits 0, does not call followMany', async () => {
    const path = tmpCreds(CREDS);
    const followSpy = jest
      .spyOn(NearlyClient.prototype, 'follow')
      .mockResolvedValue({ action: 'followed', target: 'alice.near' });
    const batchSpy = jest.spyOn(NearlyClient.prototype, 'followMany');

    const result = await runCli(
      ['follow', 'alice.near', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(followSpy).toHaveBeenCalledWith('alice.near', {});
    expect(batchSpy).not.toHaveBeenCalled();
    expect(result.stdout).toContain('followed');
    expect(result.stdout).toContain('alice.near');
  });

  test('single target with --reason forwards reason and still uses single-path', async () => {
    const path = tmpCreds(CREDS);
    const followSpy = jest
      .spyOn(NearlyClient.prototype, 'follow')
      .mockResolvedValue({ action: 'followed', target: 'alice.near' });

    const result = await runCli(
      ['follow', 'alice.near', '--reason', 'hackathon', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(followSpy).toHaveBeenCalledWith('alice.near', {
      reason: 'hackathon',
    });
  });

  test('multiple targets invokes followMany and renders rows, all success exits 0', async () => {
    const path = tmpCreds(CREDS);
    jest.spyOn(NearlyClient.prototype, 'followMany').mockResolvedValue([
      { account_id: 'alice.near', action: 'followed', target: 'alice.near' },
      { account_id: 'bob.near', action: 'followed', target: 'bob.near' },
    ]);

    const result = await runCli(
      ['follow', 'alice.near', 'bob.near', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('account_id');
    expect(result.stdout).toContain('alice.near');
    expect(result.stdout).toContain('bob.near');
    expect(result.stdout).toContain('followed');
  });

  test('--json on batch emits raw array', async () => {
    const path = tmpCreds(CREDS);
    const payload: BatchFollowItem[] = [
      { account_id: 'alice.near', action: 'followed', target: 'alice.near' },
      { account_id: 'bob.near', action: 'followed', target: 'bob.near' },
    ];
    jest.spyOn(NearlyClient.prototype, 'followMany').mockResolvedValue(payload);

    const result = await runCli(
      ['follow', 'alice.near', 'bob.near', '--config', path, '--json'],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  test('no target throws usage error with exit code 1', async () => {
    const path = tmpCreds(CREDS);
    const result = await runCli(['follow', '--config', path], NO_ENV);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage: nearly follow/);
  });
});
