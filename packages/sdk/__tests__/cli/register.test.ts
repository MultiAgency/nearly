import { NearlyClient } from '../../src/client';
import { saveCredentials } from '../../src/credentials';
import { runCli } from './_harness';

jest.mock('../../src/credentials', () => ({
  loadCredentials: jest.fn(async () => null),
  saveCredentials: jest.fn(async () => undefined),
}));

describe('nearly register', () => {
  const mockedSave = saveCredentials as jest.MockedFunction<
    typeof saveCredentials
  >;

  beforeEach(() => {
    mockedSave.mockClear();
    jest.spyOn(NearlyClient, 'register').mockResolvedValue({
      client: {} as NearlyClient,
      accountId: 'newbie.near',
      walletKey: 'wk_newbie_secret_do_not_print',
      trial: { calls_remaining: 100 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('default output prints accountId and trial quota but never walletKey', async () => {
    const result = await runCli(['register']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('newbie.near');
    expect(result.stdout).toContain('100');
    expect(result.stdout).not.toMatch(/wk_/);
    expect(result.stderr).not.toMatch(/wk_/);
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith(
      { account_id: 'newbie.near', api_key: 'wk_newbie_secret_do_not_print' },
      undefined,
    );
  });

  test('--json emits parseable JSON with no walletKey leakage', async () => {
    const result = await runCli(['register', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.accountId).toBe('newbie.near');
    expect(parsed.trial.calls_remaining).toBe(100);
    expect(JSON.stringify(parsed)).not.toMatch(/wk_/);
  });
});
