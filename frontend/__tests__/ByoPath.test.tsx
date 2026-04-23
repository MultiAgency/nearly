import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import JoinPage from '@/app/join/page';
import * as outlayer from '@/lib/outlayer';
import { useAgentStore } from '@/store/agentStore';

// Mock the outlayer HTTP surface. Keep InsufficientBalanceError as the
// real class — ByoPath's `err instanceof InsufficientBalanceError` check
// must see the same constructor identity.
jest.mock('@/lib/outlayer', () => {
  const actual = jest.requireActual('@/lib/outlayer');
  return {
    ...actual,
    verifyWallet: jest.fn(),
    getBalance: jest.fn(),
    registerOutlayer: jest.fn(),
  };
});

jest.mock('@/lib/api', () => ({
  api: { setApiKey: jest.fn(), heartbeat: jest.fn() },
  ApiError: class extends Error {
    retryAfter?: number;
  },
}));

// Handoff transitively imports next/server via platforms; trim the chain.
jest.mock('@/lib/platforms', () => ({
  PLATFORM_META: [],
}));

jest.mock('@/hooks', () => ({
  useCopyToClipboard: () => [false, jest.fn()],
  useHiddenSet: () => ({ hiddenSet: new Set(), isLoading: false }),
  useDebounce: <T,>(v: T) => v,
}));

const mockVerifyWallet = outlayer.verifyWallet as jest.MockedFunction<
  typeof outlayer.verifyWallet
>;
const mockGetBalance = outlayer.getBalance as jest.MockedFunction<
  typeof outlayer.getBalance
>;

// Funding threshold is Number(FUND_AMOUNT_NEAR) * 1e24 yoctoNEAR.
// Using string arithmetic since JS Number loses precision at 1e24.
const BELOW_THRESHOLD = '1';
const ABOVE_THRESHOLD = '99999999999999999999999999'; // 100 NEAR in yocto

beforeEach(() => {
  useAgentStore.getState().reset();
  useAgentStore.getState().choosePath('byo');
  mockVerifyWallet.mockReset();
  mockGetBalance.mockReset();
});

afterEach(() => {
  // Safety net for any test that flips to fake timers — unconditional
  // restore is a no-op when real timers are already active. The earlier
  // `if (jest.isMockFunction(setTimeout))` guard never fired because
  // fake setTimeout isn't a jest.fn().
  jest.useRealTimers();
});

function typeKey(key: string) {
  const input = screen.getByLabelText(/wallet key/i);
  fireEvent.change(input, { target: { value: key } });
}

async function clickVerify() {
  const button = screen.getByRole('button', { name: /verify wallet/i });
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('BYO pre-verify', () => {
  it('shows the input with Verify button disabled on first render', () => {
    render(<JoinPage />);
    expect(screen.getByLabelText(/wallet key/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /verify wallet/i }),
    ).toBeDisabled();
  });

  it('rejects a key without the wk_ prefix without calling verifyWallet', async () => {
    render(<JoinPage />);
    typeKey('not-a-wallet-key');
    await clickVerify();
    expect(mockVerifyWallet).not.toHaveBeenCalled();
    expect(screen.getByText(/key must start with wk_/i)).toBeInTheDocument();
  });

  it('on InsufficientBalanceError, renders the fund-wallet yellow card with OutLayer dashboard link', async () => {
    mockVerifyWallet.mockRejectedValue(new outlayer.InsufficientBalanceError());
    render(<JoinPage />);
    typeKey('wk_abc123');
    await clickVerify();
    await waitFor(() => {
      expect(screen.getByText(/doesn't have enough NEAR/i)).toBeInTheDocument();
    });
    const link = screen.getByRole('link', { name: /open outlayer dashboard/i });
    expect(link).toHaveAttribute(
      'href',
      'https://outlayer.fastnear.com/wallet/manage',
    );
  });

  it('on non-InsufficientBalance error, renders the generic error (not the fund card)', async () => {
    // "rate limit" matches friendlyError's rate-limit pattern — we get a
    // recognizable user-visible message rather than the "Something went
    // wrong" fallback, so the assertion is distinctive.
    mockVerifyWallet.mockRejectedValue(new Error('rate limit exceeded'));
    render(<JoinPage />);
    typeKey('wk_abc123');
    await clickVerify();
    await waitFor(() => {
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/doesn't have enough NEAR/i)).toBeNull();
    expect(
      screen.queryByRole('link', { name: /open outlayer dashboard/i }),
    ).toBeNull();
  });

  it('clears the fund-wallet card on retry', async () => {
    mockVerifyWallet
      .mockRejectedValueOnce(new outlayer.InsufficientBalanceError())
      .mockResolvedValueOnce({
        account_id: 'alice.near',
        balance: ABOVE_THRESHOLD,
      });
    render(<JoinPage />);
    typeKey('wk_abc123');
    await clickVerify();
    await waitFor(() => {
      expect(screen.getByText(/doesn't have enough NEAR/i)).toBeInTheDocument();
    });
    await clickVerify();
    await waitFor(() => {
      expect(screen.queryByText(/doesn't have enough NEAR/i)).toBeNull();
    });
  });
});

describe('BYO post-verify — sufficient balance', () => {
  it('renders PostFunding choice (not the low-balance card) when balance >= threshold', async () => {
    mockVerifyWallet.mockResolvedValue({
      account_id: 'alice.near',
      balance: ABOVE_THRESHOLD,
    });
    render(<JoinPage />);
    typeKey('wk_abc123');
    await clickVerify();
    await waitFor(() => {
      expect(screen.getByText(/verified account/i)).toBeInTheDocument();
    });
    // Post-funding idle panel shows Activate Now + Hand Off to My Agent.
    expect(
      screen.getByRole('button', { name: /activate now/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/balance is below/i)).toBeNull();
  });
});

describe('BYO post-verify — low balance', () => {
  beforeEach(async () => {
    mockVerifyWallet.mockResolvedValue({
      account_id: 'alice.near',
      balance: BELOW_THRESHOLD,
    });
    render(<JoinPage />);
    typeKey('wk_abc123');
    await clickVerify();
    await waitFor(() => {
      expect(screen.getByText(/balance is below/i)).toBeInTheDocument();
    });
  });

  it('shows the fund link and Re-check Balance button', () => {
    const fundLink = screen.getByRole('link', {
      name: /fund with .* NEAR/i,
    });
    expect(fundLink).toHaveAttribute(
      'href',
      expect.stringContaining('outlayer.fastnear.com/wallet/fund'),
    );
    expect(
      screen.getByRole('button', { name: /re-check balance/i }),
    ).toBeInTheDocument();
  });

  it('Re-check with non-InsufficientBalance error surfaces a recheckError banner', async () => {
    mockGetBalance.mockRejectedValue(new Error('rate limit exceeded'));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /re-check balance/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    });
    // "Watching for deposit…" is suppressed while error is active.
    expect(screen.queryByText(/watching for deposit/i)).toBeNull();
  });

  it('Re-check with InsufficientBalanceError keeps the low-balance card without a new error banner', async () => {
    mockGetBalance.mockRejectedValue(new outlayer.InsufficientBalanceError());
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /re-check balance/i }),
      );
    });
    await waitFor(() => {
      // Still shows the low-balance yellow card (balance was set to '0').
      expect(screen.getByText(/balance is below/i)).toBeInTheDocument();
    });
    // No duplicate error banner from recheckError path.
    expect(screen.queryByText(/insufficient balance/i)).toBeNull();
  });

  it('Re-check success with now-sufficient balance transitions to PostFunding', async () => {
    mockGetBalance.mockResolvedValue(ABOVE_THRESHOLD);
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /re-check balance/i }),
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /activate now/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/balance is below/i)).toBeNull();
  });
});

describe('BYO polling clears stale recheckError', () => {
  // Polling is set up inside useBalancePoll's useEffect at mount time —
  // to make the setInterval use fake timers, we must enable them before
  // render. `doNotFake: ['nextTick', 'setImmediate']` keeps async/await +
  // testing-library's waitFor responsive.
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('polling clears a stale recheckError once a poll succeeds', async () => {
    mockVerifyWallet.mockResolvedValue({
      account_id: 'alice.near',
      balance: BELOW_THRESHOLD,
    });
    // First getBalance: click-triggered recheck fails → error banner set.
    // Second getBalance: poll-triggered → success clears the banner.
    mockGetBalance
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValueOnce(BELOW_THRESHOLD);

    render(<JoinPage />);
    typeKey('wk_abc123');
    await clickVerify();
    await waitFor(() => {
      expect(screen.getByText(/balance is below/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /re-check balance/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    });

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await waitFor(() => {
      expect(screen.queryByText(/too many requests/i)).toBeNull();
    });
  });
});
