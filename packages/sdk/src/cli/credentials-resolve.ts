import { loadCredentials } from '../credentials';
import { validationError } from '../errors';

export interface ResolvedCredentials {
  walletKey: string;
  accountId: string;
}

export interface ResolveOpts {
  config?: string;
  account?: string;
  env?: NodeJS.ProcessEnv;
}

const GUIDANCE = 'No wallet key found. Run: nearly register';

export async function resolveCredentials(
  opts: ResolveOpts = {},
): Promise<ResolvedCredentials> {
  const env = opts.env ?? process.env;

  // Explicit `--account X` resolves against the credentials file only;
  // env vars are not a fallback — the caller asked for entry X, not for
  // whatever `NEARLY_WK_KEY` happens to hold.
  if (opts.account) {
    const file = await loadCredentials(opts.config);
    const entry = file?.accounts[opts.account];
    if (!entry) {
      throw validationError(
        'account',
        `no credentials for account "${opts.account}"`,
      );
    }
    // The dictionary key IS the account ID. `entry.account_id` is redundant
    // and frequently absent in real credential files written by the
    // frontend's Handoff flow (verified by dogfooding against the
    // production credentials file, which stores only `api_key` + `platforms`
    // under the key). Fall back to the key itself.
    return {
      walletKey: entry.api_key,
      accountId: entry.account_id ?? opts.account,
    };
  }

  const envKey = env.NEARLY_WK_KEY;
  const envAccount = env.NEARLY_WK_ACCOUNT_ID;
  if (envKey && envAccount) {
    return { walletKey: envKey, accountId: envAccount };
  }
  if (envKey && !envAccount) {
    throw validationError(
      'NEARLY_WK_ACCOUNT_ID',
      'NEARLY_WK_KEY set without NEARLY_WK_ACCOUNT_ID',
    );
  }

  const file = await loadCredentials(opts.config);
  if (!file) {
    throw validationError('credentials', GUIDANCE);
  }
  const ids = Object.keys(file.accounts);
  if (ids.length === 0) {
    throw validationError('credentials', GUIDANCE);
  }
  if (ids.length === 1) {
    const entry = file.accounts[ids[0]];
    return {
      walletKey: entry.api_key,
      accountId: entry.account_id ?? ids[0],
    };
  }
  throw validationError(
    'account',
    `multiple accounts in credentials.json; pass --account <id> (known: ${ids.join(', ')})`,
  );
}
