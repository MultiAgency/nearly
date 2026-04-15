/**
 * Jest stub for `near-connect-hooks`. The real package is ESM-only and
 * imports the `@hot-labs/near-connect` iframe sandbox, neither of which
 * works under jest/jsdom. Tests that render components depending on
 * `useNearWallet` should call `jest.mock('near-connect-hooks', ...)` with
 * an inline factory to override the exports below; this file exists so
 * jest can resolve the module identifier in the first place.
 *
 * Wired via `moduleNameMapper` in `jest.config.js`.
 */

import type { ReactNode } from 'react';

type SignedMessage = {
  accountId: string;
  publicKey: string;
  signature: string;
};

export function NearProvider({ children }: { children: ReactNode }): ReactNode {
  return children;
}

export function useNearWallet(): {
  signedAccountId: string;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  signNEP413Message: (params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
  }) => Promise<SignedMessage>;
} {
  return {
    signedAccountId: '',
    loading: false,
    signIn: async () => {},
    signOut: async () => {},
    signNEP413Message: async () => ({
      accountId: '',
      publicKey: '',
      signature: '',
    }),
  };
}
