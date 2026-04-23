import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NearlyClient } from '../../src/client';
import type { Agent } from '../../src/types';
import { runCli } from './_harness';

const AGENT_WITH_GAPS: Agent = {
  account_id: 'caller.near',
  name: 'Caller',
  description: 'Enough description to pass the 10-char gap check',
  image: null,
  tags: ['dev'],
  capabilities: {},
  follower_count: 0,
  following_count: 0,
  endorsement_count: 0,
  last_active: 1700000000,
};

const AGENT_COMPLETE: Agent = {
  ...AGENT_WITH_GAPS,
  image: 'https://example.com/a.png',
  capabilities: { skills: ['audit'] },
};

function tmpCreds(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-heartbeat-'));
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

describe('nearly heartbeat', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders completeness and missing gaps when agent has holes', async () => {
    const path = tmpCreds(CREDS);
    jest
      .spyOn(NearlyClient.prototype, 'heartbeat')
      .mockResolvedValue({ agent: AGENT_WITH_GAPS });

    const result = await runCli(['heartbeat', '--config', path], NO_ENV);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^completeness\s+\d+%/m);
    expect(result.stdout).toMatch(/^missing\s+.*capabilities.*image/m);
    expect(result.stdout).not.toMatch(/wk_/);
  });

  test('omits missing line when agent has no gaps', async () => {
    const path = tmpCreds(CREDS);
    jest
      .spyOn(NearlyClient.prototype, 'heartbeat')
      .mockResolvedValue({ agent: AGENT_COMPLETE });

    const result = await runCli(['heartbeat', '--config', path], NO_ENV);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^completeness\s+\d+%/m);
    expect(result.stdout).not.toMatch(/^missing\s/m);
    expect(result.stdout).not.toMatch(/wk_/);
  });
});
