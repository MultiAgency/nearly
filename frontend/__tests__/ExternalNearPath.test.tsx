import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import JoinPage from '@/app/join/page';
import { useAgentStore } from '@/store/agentStore';

// Mock the SDK helpers the component uses. Both createDeterministicWallet
// and mintDelegateKey are imported directly from @nearly/sdk.
jest.mock('@nearly/sdk', () => {
  const actual = jest.requireActual('@nearly/sdk');
  return {
    ...actual,
    createDeterministicWallet: jest.fn(),
    mintDelegateKey: jest.fn(),
  };
});

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

import { createDeterministicWallet, mintDelegateKey } from '@nearly/sdk';
import { api } from '@/lib/api';

const mockCreate = createDeterministicWallet as jest.MockedFunction<
  typeof createDeterministicWallet
>;
const mockMint = mintDelegateKey as jest.MockedFunction<typeof mintDelegateKey>;
const mockSetApiKey = api.setApiKey as jest.MockedFunction<
  typeof api.setApiKey
>;

const FIXTURE_PRIVATE_KEY =
  'ed25519:4jt4Rz3i9xLFD1A9NfZCLFa3g4cSxu12N4pX8YVvZABCdefGHIJKLmnop';
const FIXTURE_ACCOUNT = 'alice.near';
const FIXTURE_SEED = 'task-42';
const FIXTURE_WALLET_ID = 'uuid-deadbeef';
const FIXTURE_NEAR_ACCOUNT =
  '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88';
const FIXTURE_MINTED_WK =
  'wk_minted_session_scoped_key_for_tests_000000000000000000000000';

beforeEach(() => {
  useAgentStore.getState().reset();
  useAgentStore.getState().choosePath('external-near');
  mockCreate.mockReset();
  mockMint.mockReset();
  mockSetApiKey.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function fillForm({
  accountId = FIXTURE_ACCOUNT,
  seed = FIXTURE_SEED,
  privateKey = FIXTURE_PRIVATE_KEY,
}: {
  accountId?: string;
  seed?: string;
  privateKey?: string;
} = {}) {
  fireEvent.change(screen.getByLabelText(/near account id/i), {
    target: { value: accountId },
  });
  fireEvent.change(screen.getByLabelText(/^seed/i), {
    target: { value: seed },
  });
  fireEvent.change(screen.getByLabelText(/near private key/i), {
    target: { value: privateKey },
  });
}

async function toggleMintCheckbox() {
  const checkbox = screen.getByRole('checkbox', { name: /also mint/i });
  await act(async () => {
    fireEvent.click(checkbox);
  });
}

async function clickSubmit() {
  const button = screen.getByRole('button', {
    name: /provision (derived|\+ activate)/i,
  });
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('ExternalNearPath — default mint flow', () => {
  beforeEach(() => {
    mockCreate.mockResolvedValueOnce({
      walletId: FIXTURE_WALLET_ID,
      nearAccountId: FIXTURE_NEAR_ACCOUNT,
      trial: { calls_remaining: 100 },
    });
    mockMint.mockResolvedValueOnce({
      walletId: FIXTURE_WALLET_ID,
      nearAccountId: FIXTURE_NEAR_ACCOUNT,
      walletKey: FIXTURE_MINTED_WK,
    });
  });

  test('submits both calls, activates wk_ via ApiClient, renders PostFunding', async () => {
    render(<JoinPage />);
    fillForm();
    await clickSubmit();

    await waitFor(() => {
      expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockMint).toHaveBeenCalledTimes(1);
    // ApiClient activation — session-scoped.
    expect(mockSetApiKey).toHaveBeenCalledWith(FIXTURE_MINTED_WK);
    // PostFunding renders its "Activate Now" button since heartbeat is idle.
    expect(
      screen.getByRole('button', { name: /activate now/i }),
    ).toBeInTheDocument();
  });

  test('success screen shows the minted wk_ via MaskedCopyField, not the old "provisioning only" copy', async () => {
    render(<JoinPage />);
    fillForm();
    await clickSubmit();

    await waitFor(() => {
      expect(screen.getByText(/delegate wallet key/i)).toBeInTheDocument();
    });
    // No "provisioning only" copy on the mint-successful branch.
    expect(
      screen.queryByText(/provisioning only\. no .* was issued/i),
    ).toBeNull();
  });
});

describe('ExternalNearPath — opt-out (--no-mint-key)', () => {
  beforeEach(() => {
    mockCreate.mockResolvedValueOnce({
      walletId: FIXTURE_WALLET_ID,
      nearAccountId: FIXTURE_NEAR_ACCOUNT,
      trial: { calls_remaining: 100 },
    });
  });

  test('unchecking the mint checkbox skips mintDelegateKey and renders provisioning-only copy', async () => {
    render(<JoinPage />);
    fillForm();
    await toggleMintCheckbox();
    await clickSubmit();

    await waitFor(() => {
      expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
    });
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockSetApiKey).not.toHaveBeenCalled();
    expect(screen.getByText(/provisioning only/i)).toBeInTheDocument();
    expect(screen.queryByText(/delegate wallet key/i)).toBeNull();
  });
});

describe('ExternalNearPath — failure paths', () => {
  test('rejects missing prefix on the private key before any SDK call', async () => {
    render(<JoinPage />);
    fillForm({ privateKey: 'not-an-ed25519-key' });
    await clickSubmit();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
    expect(screen.getByText(/must start with "ed25519:"/i)).toBeInTheDocument();
  });

  test('mint failure after provision success surfaces partial-state error without leaking key', async () => {
    mockCreate.mockResolvedValueOnce({
      walletId: FIXTURE_WALLET_ID,
      nearAccountId: FIXTURE_NEAR_ACCOUNT,
      trial: { calls_remaining: 100 },
    });
    mockMint.mockRejectedValueOnce(
      Object.assign(new Error('mint upstream 500'), {
        code: 'PROTOCOL',
        shape: { code: 'PROTOCOL', hint: 'mint upstream 500' },
      }),
    );

    render(<JoinPage />);
    fillForm();
    await clickSubmit();

    await waitFor(() => {
      expect(useAgentStore.getState().externalNearStatus).toBe('error');
    });
    const { externalNearError } = useAgentStore.getState();
    expect(externalNearError).toMatch(/provisioned/i);
    expect(externalNearError).toMatch(/minting failed/i);
    expect(externalNearError).toMatch(/re-enter your NEAR key/i);
    const privBody = FIXTURE_PRIVATE_KEY.slice('ed25519:'.length);
    expect(externalNearError ?? '').not.toContain(privBody);
    expect(mockSetApiKey).not.toHaveBeenCalled();
    const privateKeyInput = screen.getByLabelText(
      /near private key/i,
    ) as HTMLInputElement;
    expect(privateKeyInput.value).toBe('');
  });
});

describe('ExternalNearPath — key-leak safety', () => {
  beforeEach(() => {
    mockCreate.mockResolvedValueOnce({
      walletId: FIXTURE_WALLET_ID,
      nearAccountId: FIXTURE_NEAR_ACCOUNT,
      trial: { calls_remaining: 100 },
    });
    mockMint.mockResolvedValueOnce({
      walletId: FIXTURE_WALLET_ID,
      nearAccountId: FIXTURE_NEAR_ACCOUNT,
      walletKey: FIXTURE_MINTED_WK,
    });
  });

  test('never persists the private key to browser storage', async () => {
    render(<JoinPage />);
    fillForm();
    await clickSubmit();

    await waitFor(() => {
      expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
    });

    const privBody = FIXTURE_PRIVATE_KEY.slice('ed25519:'.length);
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)!;
      const value = window.localStorage.getItem(key);
      expect(value ?? '').not.toContain(privBody);
    }
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i)!;
      const value = window.sessionStorage.getItem(key);
      expect(value ?? '').not.toContain(privBody);
    }
  });

  test('minted wk_ is NOT persisted to browser storage — session-scoped only', async () => {
    render(<JoinPage />);
    fillForm();
    await clickSubmit();

    await waitFor(() => {
      expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
    });

    // The wk_ is activated via ApiClient.setApiKey (in-memory singleton),
    // NOT written to localStorage / sessionStorage. Durability is the
    // user's responsibility via the copy button.
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)!;
      const value = window.localStorage.getItem(key);
      expect(value ?? '').not.toContain(FIXTURE_MINTED_WK);
    }
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i)!;
      const value = window.sessionStorage.getItem(key);
      expect(value ?? '').not.toContain(FIXTURE_MINTED_WK);
    }
  });
});
