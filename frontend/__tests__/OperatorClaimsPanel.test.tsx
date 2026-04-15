import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { OperatorClaimsPanel } from '@/app/(market)/agents/[accountId]/OperatorClaimsPanel';
import type { OperatorClaimEntry } from '@/types';

// Mock near-connect-hooks so the component never touches the real NEAR
// Connect iframe / IndexedDB. `NearProvider` is a pass-through wrapper
// in tests; `useNearWallet` returns whatever state we've staged.
const mockWalletState = {
  signedAccountId: '',
  loading: false,
  signIn: jest.fn().mockResolvedValue(undefined),
  signNEP413Message: jest.fn(),
};

jest.mock('near-connect-hooks', () => ({
  NearProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useNearWallet: () => mockWalletState,
}));

// Mock the sign-claim helper so we don't reach into Web Crypto or Borsh
// in a jest/jsdom environment. The component only cares that signClaim
// resolves with a plausible VerifiableClaim shape.
jest.mock('@/lib/sign-claim', () => ({
  signClaim: jest.fn().mockResolvedValue({
    account_id: 'alice.near',
    public_key: 'ed25519:mock',
    signature: 'ed25519:mocksig',
    nonce: 'bW9ja25vbmNl',
    message: '{"mock": true}',
  }),
}));

// Mock the ApiClient surface the panel touches. Jest module mocking is
// necessary because the panel imports the singleton `api` instance.
const mockGetAgentClaims = jest.fn();
const mockClaimOperator = jest.fn();
const mockUnclaimOperator = jest.fn();
const mockSetAuth = jest.fn();

jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public statusCode: number,
      message: string,
      public code?: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    api: {
      getAgentClaims: (...args: unknown[]) => mockGetAgentClaims(...args),
      claimOperator: (...args: unknown[]) => mockClaimOperator(...args),
      unclaimOperator: (...args: unknown[]) => mockUnclaimOperator(...args),
      setAuth: (...args: unknown[]) => mockSetAuth(...args),
    },
    ApiError,
  };
});

// Hidden-set hook — the panel filters operators through it. Default: no
// agents hidden. Individual tests override when they need to exercise
// the admin-suppression code path.
const mockHiddenSet = new Set<string>();
jest.mock('@/hooks', () => ({
  useHiddenSet: () => ({ hiddenSet: mockHiddenSet, isLoading: false }),
}));

const AGENT = 'bob.near';

function entry(
  operator: string,
  overrides: Partial<OperatorClaimEntry> = {},
): OperatorClaimEntry {
  return {
    account_id: operator,
    name: operator.split('.')[0],
    description: '',
    image: null,
    message: JSON.stringify({
      action: 'claim_operator',
      domain: 'nearly.social',
      account_id: operator,
      version: 1,
      timestamp: 1_700_000_000_000,
    }),
    signature: 'ed25519:sig',
    public_key: 'ed25519:pk',
    nonce: 'bW9ja25vbmNl',
    at: 1_700_000_000,
    at_height: 500,
    ...overrides,
  };
}

/**
 * Render helper. Wraps the panel in SWR's test-friendly config — clears
 * the cache between renders so the component fetches fresh for each test,
 * and disables dedupe so sequential revalidates land against the mock.
 */
function renderPanel(accountId = AGENT) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <OperatorClaimsPanel accountId={accountId} />
    </SWRConfig>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHiddenSet.clear();
  mockWalletState.signedAccountId = '';
  mockWalletState.loading = false;
});

describe('OperatorClaimsPanel', () => {
  it('shows "sign in to claim" CTA when the viewer is not signed in and no one has claimed', async () => {
    mockGetAgentClaims.mockResolvedValue({
      account_id: AGENT,
      operators: [],
    });
    renderPanel();

    // Empty-state copy + CTA button.
    await screen.findByText(/no human has signed a nep-413 claim/i);
    const cta = screen.getByRole('button', {
      name: /sign in to claim this agent/i,
    });
    expect(cta).toBeInTheDocument();
  });

  it('renders existing operators as a badge list with block-authoritative timestamps', async () => {
    mockGetAgentClaims.mockResolvedValue({
      account_id: AGENT,
      operators: [
        entry('alice.near', { name: 'Alice', reason: 'original human' }),
        entry('dave.near', { name: 'Dave' }),
      ],
    });
    renderPanel();

    await screen.findByText('alice.near');
    screen.getByText('dave.near');
    screen.getByText('Alice');
    screen.getByText(/"original human"/);
    // Header shows the count.
    screen.getByText('Verified operators');
    screen.getByText(/2 operators/);
  });

  it('does not render operators suppressed by the hidden set', async () => {
    mockHiddenSet.add('dave.near');
    mockGetAgentClaims.mockResolvedValue({
      account_id: AGENT,
      operators: [entry('alice.near'), entry('dave.near')],
    });
    renderPanel();

    await screen.findByText('alice.near');
    expect(screen.queryByText('dave.near')).toBeNull();
    // Count reflects the post-filter list, not the raw response.
    screen.getByText(/1 operator/);
  });

  it('shows "Claim this agent" for signed-in viewer who has not yet claimed', async () => {
    mockWalletState.signedAccountId = 'carol.near';
    mockGetAgentClaims.mockResolvedValue({
      account_id: AGENT,
      operators: [entry('alice.near')],
    });
    renderPanel();

    await screen.findByText('alice.near');
    // CTA is active — viewer is signed in but is NOT alice, so they can
    // file their own claim.
    screen.getByRole('button', { name: /claim this agent/i });
    // `carol.near` should appear in the signed-in footer.
    screen.getByText('carol.near');
  });

  it('marks the viewer own claim with a "you" badge and shows "Remove my claim"', async () => {
    mockWalletState.signedAccountId = 'alice.near';
    mockGetAgentClaims.mockResolvedValue({
      account_id: AGENT,
      operators: [entry('alice.near')],
    });
    renderPanel();

    await screen.findByText('alice.near');
    // The "you" chip is rendered next to alice's entry.
    screen.getByText('you');
    // The claim CTA flips to the retraction control.
    screen.getByRole('button', { name: /remove my claim/i });
  });

  it('claim action mints a fresh NEP-413 envelope, posts it, and revalidates', async () => {
    mockWalletState.signedAccountId = 'carol.near';
    // First read: no operators. After the write we revalidate and the
    // second read surfaces carol's new claim.
    mockGetAgentClaims
      .mockResolvedValueOnce({ account_id: AGENT, operators: [] })
      .mockResolvedValueOnce({
        account_id: AGENT,
        operators: [entry('carol.near')],
      });
    mockClaimOperator.mockResolvedValue({
      action: 'claimed',
      operator_account_id: 'carol.near',
      agent_account_id: AGENT,
    });

    renderPanel();

    const btn = await screen.findByRole('button', {
      name: /claim this agent/i,
    });
    fireEvent.click(btn);

    // The write funnel runs in order: setAuth → claimOperator → setAuth(null)
    // → revalidate. Wait for the revalidation effect to land and carol's
    // entry to appear in the DOM.
    await waitFor(() => screen.getByText('carol.near'));

    expect(mockClaimOperator).toHaveBeenCalledWith(AGENT);
    // Claim stash is cleared after the write — single-use semantics.
    expect(mockSetAuth).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ signature: 'ed25519:mocksig' }),
    );
    expect(mockSetAuth).toHaveBeenLastCalledWith(null);
  });

  it('unclaim action retracts the viewer claim and clears it from the badge', async () => {
    mockWalletState.signedAccountId = 'alice.near';
    mockGetAgentClaims
      .mockResolvedValueOnce({
        account_id: AGENT,
        operators: [entry('alice.near')],
      })
      .mockResolvedValueOnce({ account_id: AGENT, operators: [] });
    mockUnclaimOperator.mockResolvedValue({
      action: 'unclaimed',
      operator_account_id: 'alice.near',
      agent_account_id: AGENT,
    });

    renderPanel();
    await screen.findByText('alice.near');

    fireEvent.click(screen.getByRole('button', { name: /remove my claim/i }));

    // After revalidation the badge list goes empty and the CTA reverts
    // to the signed-in "Claim this agent" button.
    await waitFor(() =>
      screen.getByText(/no human has signed a nep-413 claim/i),
    );
    expect(mockUnclaimOperator).toHaveBeenCalledWith(AGENT);
  });

  it('surfaces write errors without clobbering the existing badge state', async () => {
    mockWalletState.signedAccountId = 'carol.near';
    mockGetAgentClaims.mockResolvedValue({
      account_id: AGENT,
      operators: [entry('alice.near')],
    });
    // Write throws — e.g. rate limited, service key unset, etc.
    mockClaimOperator.mockRejectedValue(new Error('Rate limited'));

    renderPanel();

    await screen.findByText('alice.near');
    fireEvent.click(screen.getByRole('button', { name: /claim this agent/i }));

    await waitFor(() => screen.getByText(/rate limited/i));
    // Alice's claim is still in the badge — the failed write didn't
    // drop the existing state.
    screen.getByText('alice.near');
    // Claim stash should be cleared on error so the next mint is fresh.
    expect(mockSetAuth).toHaveBeenLastCalledWith(null);
  });

  it('surfaces read errors with a retry-able error card', async () => {
    mockGetAgentClaims.mockRejectedValue(new Error('FastData unreachable'));
    renderPanel();

    // `friendlyError` rewrites raw read errors into a generic retryable
    // message — we assert on the containing error card, not the raw
    // error text, because the error-to-copy mapping is not part of this
    // component's contract.
    await screen.findByText(/couldn't load operator claims/i);
  });
});
