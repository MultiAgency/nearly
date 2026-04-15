/**
 * @jest-environment node
 *
 * Sentinel test: verifies `@nearly/sdk` resolves from the frontend via the
 * tsconfig path alias + jest moduleNameMapper wire-up. Keeps CI honest
 * about the monorepo consumption story — if someone breaks the wiring
 * (renames the path alias, deletes the jest mapper, moves the SDK), this
 * goes red before any real import does.
 *
 * Currently just asserts a value import succeeds. When real handler code
 * starts consuming the SDK, this test stays as the shallow smoke check;
 * deeper coverage moves into the handler's own tests.
 */

import type { Agent, RegisterResult } from '@nearly/sdk';
import { NearlyClient, NearlyError, protocolError } from '@nearly/sdk';

describe('@nearly/sdk consumption from frontend', () => {
  it('resolves value imports (NearlyError class + factory)', () => {
    expect(typeof NearlyError).toBe('function');
    const err = protocolError('smoke');
    expect(err).toBeInstanceOf(NearlyError);
    expect(err.code).toBe('PROTOCOL');
  });

  it('resolves NearlyClient as a constructable class', () => {
    expect(typeof NearlyClient).toBe('function');
  });

  it('resolves type-only imports (Agent, RegisterResult)', () => {
    // Exists purely so tsc path resolution is exercised on types.
    const _agent: Agent | null = null;
    const _result: RegisterResult | null = null;
    expect(_agent).toBeNull();
    expect(_result).toBeNull();
  });
});
