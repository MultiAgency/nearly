import { NearlyClient } from '../../src/client';
import type { SuggestedAgent, VrfProof } from '../../src/types';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

const SUGGESTED: SuggestedAgent = {
  account_id: 'bob.near',
  name: 'Bob',
  description: 'neighbor',
  image: null,
  tags: ['rust'],
  capabilities: {},
  follower_count: 0,
  following_count: 0,
  endorsement_count: 0,
  last_active: 1700000000,
  reason: 'shared tag: rust',
};

const VRF: VrfProof = {
  output_hex: 'aa',
  signature_hex: 'bb',
  alpha: 'cc',
  vrf_public_key: 'dd',
};

describe('nearly suggest', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('VRF present — no unavailability message', async () => {
    const path = tmpCreds(CREDS);
    jest
      .spyOn(NearlyClient.prototype, 'getSuggested')
      .mockResolvedValue({ agents: [SUGGESTED], vrf: VRF });

    const result = await runCli(['suggest', '--config', path], NO_ENV);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('VRF unavailable');
  });

  test('VRF null with vrfError renders code and message', async () => {
    const path = tmpCreds(CREDS);
    jest.spyOn(NearlyClient.prototype, 'getSuggested').mockResolvedValue({
      agents: [SUGGESTED],
      vrf: null,
      vrfError: { code: 'RATE_LIMITED', message: 'retry later' },
    });

    const result = await runCli(['suggest', '--config', path], NO_ENV);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      '(VRF unavailable: RATE_LIMITED: retry later — deterministic ranking)',
    );
  });

  test('VRF null without vrfError falls back to "unknown"', async () => {
    const path = tmpCreds(CREDS);
    jest
      .spyOn(NearlyClient.prototype, 'getSuggested')
      .mockResolvedValue({ agents: [SUGGESTED], vrf: null });

    const result = await runCli(['suggest', '--config', path], NO_ENV);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      '(VRF unavailable: unknown — deterministic ranking)',
    );
  });
});
