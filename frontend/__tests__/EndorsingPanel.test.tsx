import { render, screen, waitFor } from '@testing-library/react';
import { EndorsingPanel } from '@/app/(market)/agents/[accountId]/EndorsingPanel';

jest.mock('@/hooks', () => ({
  useHiddenSet: jest.fn(),
}));

jest.mock('@/lib/api', () => ({
  api: {
    getEndorsing: jest.fn(),
  },
}));

// AgentAvatar pulls in image/next deps unneeded here. The mock renders
// only a testid — no name text — so `getByText(name)` finds exactly
// one match (the sibling span), not two.
jest.mock('@/app/(market)/agents/AgentAvatar', () => ({
  AgentAvatar: () => <div data-testid="agent-avatar" />,
}));

import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';

const mockedUseHiddenSet = useHiddenSet as jest.MockedFunction<
  typeof useHiddenSet
>;
const mockedGetEndorsing = api.getEndorsing as jest.MockedFunction<
  typeof api.getEndorsing
>;

function endorsingResponse() {
  return {
    account_id: 'alice.near',
    endorsing: {
      'visible.near': {
        target: {
          account_id: 'visible.near',
          name: 'Visible Agent',
          description: 'public',
          image: null,
        },
        entries: [
          {
            key_suffix: 'tags/rust',
            at: 1700000000,
            at_height: 1,
          },
        ],
      },
      'hidden.near': {
        target: {
          account_id: 'hidden.near',
          name: 'Hidden Agent',
          description: 'suppressed',
          image: null,
        },
        entries: [
          {
            key_suffix: 'tags/python',
            at: 1700000000,
            at_height: 2,
          },
        ],
      },
    },
  };
}

describe('EndorsingPanel', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // Load-bearing test for the presentation-layer hidden-set filter.
  // Read handlers return the raw graph truth; suppression lives at
  // render-time via `useHiddenSet`. Regression here would leak hidden
  // accounts into the UI — worst case user-visible, not just a test gap.
  it('filters hidden targets out of the rendered endorsing list', async () => {
    mockedUseHiddenSet.mockReturnValue({
      hiddenSet: new Set(['hidden.near']),
      isLoading: false,
    });
    mockedGetEndorsing.mockResolvedValue(endorsingResponse());

    render(<EndorsingPanel accountId="alice.near" onClose={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Visible Agent')).toBeTruthy();
    });
    expect(screen.queryByText('Hidden Agent')).toBeNull();
  });

  it('renders all targets when the hidden set is empty', async () => {
    mockedUseHiddenSet.mockReturnValue({
      hiddenSet: new Set(),
      isLoading: false,
    });
    mockedGetEndorsing.mockResolvedValue(endorsingResponse());

    render(<EndorsingPanel accountId="alice.near" onClose={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Visible Agent')).toBeTruthy();
      expect(screen.getByText('Hidden Agent')).toBeTruthy();
    });
  });

  it('renders an empty state when the response has no endorsing groups', async () => {
    mockedUseHiddenSet.mockReturnValue({
      hiddenSet: new Set(),
      isLoading: false,
    });
    mockedGetEndorsing.mockResolvedValue({
      account_id: 'alice.near',
      endorsing: {},
    });

    render(<EndorsingPanel accountId="alice.near" onClose={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/not endorsing anyone yet/i)).toBeTruthy();
    });
  });
});
