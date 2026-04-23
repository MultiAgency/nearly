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

jest.mock('@/lib/platforms', () => ({
  PLATFORM_META: [],
}));

jest.mock('@/hooks', () => ({
  useCopyToClipboard: () => [false, jest.fn()],
  useHiddenSet: () => ({ hiddenSet: new Set(), isLoading: false }),
  useDebounce: <T,>(v: T) => v,
}));

const mockGetBalance = outlayer.getBalance as jest.MockedFunction<
  typeof outlayer.getBalance
>;

const TEST_ACCOUNT = 'alice.near';
const TEST_KEY = 'wk_test_abcdef';
const BELOW_THRESHOLD = '1';
const ABOVE_THRESHOLD = '99999999999999999999999999';

function seedCompletedStep1() {
  useAgentStore.getState().reset();
  useAgentStore.getState().completeStep1({
    api_key: TEST_KEY,
    near_account_id: TEST_ACCOUNT,
    trial: { calls_remaining: 100 },
  });
  useAgentStore.getState().choosePath('new');
}

beforeEach(() => {
  mockGetBalance.mockReset();
});

afterEach(() => {
  // Safety net for any test that flips to fake timers — unconditional
  // restore is a no-op when real timers are already active. The earlier
  // `if (jest.isMockFunction(setTimeout))` guard never fired because
  // fake setTimeout isn't a jest.fn().
  jest.useRealTimers();
});

describe('NewWalletPath — step 1 success card', () => {
  it('renders the NEAR account and security warning', () => {
    seedCompletedStep1();
    render(<JoinPage />);
    expect(screen.getByText(TEST_ACCOUNT)).toBeInTheDocument();
    expect(screen.getByText(/shown only once/i)).toBeInTheDocument();
    // MaskedCopyField renders the "Wallet Key" label.
    expect(screen.getByText(/wallet key/i)).toBeInTheDocument();
  });
});

describe('NewWalletPath — step 2 initial state', () => {
  beforeEach(() => {
    seedCompletedStep1();
    render(<JoinPage />);
  });

  it('shows the fund link pointing at OutLayer with the account id', () => {
    const link = screen.getByRole('link', { name: /fund with .* NEAR/i });
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('outlayer.fastnear.com/wallet/fund');
    expect(href).toContain(encodeURIComponent(TEST_ACCOUNT));
  });

  it('shows the Check Balance button and deposit-watch hint', () => {
    expect(
      screen.getByRole('button', { name: /check balance/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/watching for deposit/i)).toBeInTheDocument();
  });
});

describe('NewWalletPath — step 2 manual check', () => {
  beforeEach(() => {
    seedCompletedStep1();
  });

  it('sufficient balance transitions to PostFunding', async () => {
    mockGetBalance.mockResolvedValue(ABOVE_THRESHOLD);
    render(<JoinPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /activate now/i }),
      ).toBeInTheDocument();
    });
  });

  it('low balance surfaces step error and renames button to Re-check Balance', async () => {
    mockGetBalance.mockResolvedValue(BELOW_THRESHOLD);
    render(<JoinPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
    });
    await waitFor(() => {
      // stepErrors[2] text includes "need ≥" and "Fund your wallet".
      expect(screen.getByText(/need ≥/i)).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /re-check balance/i }),
    ).toBeInTheDocument();
  });

  it('InsufficientBalanceError from getBalance surfaces a step 2 error without crashing', async () => {
    mockGetBalance.mockRejectedValue(new outlayer.InsufficientBalanceError());
    render(<JoinPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
    });
    // NewWalletPath routes errors through stepErrorMessage → friendlyError,
    // which has no pattern for InsufficientBalanceError and falls through
    // to the generic "Something went wrong" message. The button-label
    // rename is the clearer signal that the error path ran.
    //
    // ByoPath catches InsufficientBalanceError specifically and renders
    // the yellow fund-wallet card — NewWalletPath currently doesn't
    // (asymmetric UX, deliberate test pin). If friendlyError ever gets
    // an /insufficient balance/i pattern OR NewWalletPath gains its own
    // typed catch, update the /something went wrong/i assertion below
    // to match the new specific message.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /re-check balance/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('non-InsufficientBalance getBalance error surfaces a step 2 error', async () => {
    mockGetBalance.mockRejectedValue(new Error('rate limit exceeded'));
    render(<JoinPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
    });
    await waitFor(() => {
      expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    });
  });
});

describe('NewWalletPath — polling auto-advances step 2', () => {
  beforeEach(() => {
    // Enable fake timers BEFORE render so useBalancePoll's setInterval
    // picks up the fake clock. See ByoPath.test.tsx polling note.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('auto-advances to PostFunding when a poll sees balance >= threshold', async () => {
    seedCompletedStep1();
    mockGetBalance.mockResolvedValue(ABOVE_THRESHOLD);
    render(<JoinPage />);

    // Before the first poll, the Check Balance button (manual trigger) is
    // visible and PostFunding is not.
    expect(
      screen.getByRole('button', { name: /check balance/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /activate now/i })).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /activate now/i }),
      ).toBeInTheDocument();
    });
  });

  it('poll skips a tick while a manual Check Balance is in-flight (shouldSkipTick guard)', async () => {
    seedCompletedStep1();

    // Hold the manual getBalance unresolved. While handleStep2 is suspended
    // on the await, stepStatus[2] === 'loading' — shouldSkipTick must return
    // true, and the poll tick must not fire a second getBalance (which
    // would race the manual completion to call completeStep2).
    let resolveManual: (balance: string) => void = () => {};
    const manualPromise = new Promise<string>((r) => {
      resolveManual = r;
    });
    mockGetBalance.mockImplementationOnce(() => manualPromise);

    render(<JoinPage />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
    });

    // Manual call started, promise held, stepStatus[2] = 'loading'.
    expect(mockGetBalance).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    // Poll tick saw 'loading' and skipped — getBalance still at one call.
    expect(mockGetBalance).toHaveBeenCalledTimes(1);

    // Release the held promise so handleStep2 can finish cleanly.
    await act(async () => {
      resolveManual(ABOVE_THRESHOLD);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /activate now/i }),
      ).toBeInTheDocument();
    });
  });
});
