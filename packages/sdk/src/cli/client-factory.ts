import { NearlyClient } from '../client';
import type { ParsedGlobals } from './argv';
import { resolveCredentials } from './credentials-resolve';

export async function buildClient(
  globals: ParsedGlobals,
): Promise<NearlyClient> {
  const creds = await resolveCredentials({
    config: globals.config,
    account: globals.account,
  });
  return new NearlyClient({
    walletKey: creds.walletKey,
    accountId: creds.accountId,
  });
}
