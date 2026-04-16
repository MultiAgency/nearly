import { COMMANDS } from '../../src/cli/commands';
import { NearlyClient } from '../../src/client';
import { NearlyError, type NearlyErrorShape } from '../../src/errors';
import { runCli } from './_harness';

const LEAKY_KEY = 'wk_sweep_secret_key_do_not_print_abc123';
const LEAKY_ACCOUNT = 'sweep.near';

const ENV = {
  NEARLY_WK_KEY: LEAKY_KEY,
  NEARLY_WK_ACCOUNT_ID: LEAKY_ACCOUNT,
};

// Every shape in `NearlyErrorShape`. The sweep runs each command against
// each shape: if a command file ever interpolates `client.walletKey` (or
// any wk_-carrying string) into an output path, the sweep catches it.
const ERROR_SHAPES: NearlyErrorShape[] = [
  {
    code: 'VALIDATION_ERROR',
    field: 'x',
    reason: 'y',
    message: 'validation failed',
  },
  { code: 'SELF_FOLLOW', message: 'cannot follow self' },
  { code: 'SELF_ENDORSE', message: 'cannot endorse self' },
  { code: 'NOT_FOUND', resource: 'agent:x', message: 'not found' },
  { code: 'AUTH_FAILED', message: 'bad token' },
  {
    code: 'INSUFFICIENT_BALANCE',
    required: '0.01',
    balance: '0',
    message: 'fund wallet',
  },
  {
    code: 'RATE_LIMITED',
    action: 'social.follow',
    retryAfter: 30,
    message: 'rate limited',
  },
  { code: 'NETWORK', cause: 'econnrefused', message: 'network down' },
  { code: 'PROTOCOL', hint: 'bad response', message: 'protocol error' },
];

// (command argv, NearlyClient method to stub). Methods that return
// AsyncIterable<T> are stubbed with a generator that throws. Methods
// that return Promise<T> are stubbed with mockRejectedValue.
interface Case {
  argv: string[];
  method: keyof NearlyClient;
  iterator?: boolean;
}

const CASES: Case[] = [
  { argv: ['activity'], method: 'getActivity' },
  { argv: ['agent', 'bob.near'], method: 'getAgent' },
  { argv: ['agents'], method: 'listAgents', iterator: true },
  { argv: ['balance'], method: 'getBalance' },
  { argv: ['capabilities'], method: 'listCapabilities', iterator: true },
  { argv: ['delist', '--yes'], method: 'delist' },
  {
    argv: ['endorse', 'bob.near', '--key-suffix', 'tags/rust'],
    method: 'endorse',
  },
  { argv: ['follow', 'bob.near'], method: 'follow' },
  { argv: ['followers', 'bob.near'], method: 'getFollowers', iterator: true },
  { argv: ['following', 'bob.near'], method: 'getFollowing', iterator: true },
  { argv: ['heartbeat'], method: 'heartbeat' },
  { argv: ['me'], method: 'getMe' },
  { argv: ['network'], method: 'getNetwork' },
  { argv: ['suggest'], method: 'getSuggested' },
  { argv: ['tags'], method: 'listTags', iterator: true },
  {
    argv: ['unendorse', 'bob.near', '--key-suffix', 'tags/rust'],
    method: 'unendorse',
  },
  { argv: ['unfollow', 'bob.near'], method: 'unfollow' },
  { argv: ['update', '--name', 'Sweep'], method: 'updateMe' },
];

const WK_PATTERN = /wk_[A-Za-z0-9_]+/;

function stub(
  method: keyof NearlyClient,
  err: NearlyError,
  iterator: boolean,
): void {
  // biome-ignore lint/suspicious/noExplicitAny: sweep spies by dynamic key.
  const proto = NearlyClient.prototype as any;
  if (iterator) {
    // Return an object with a [Symbol.asyncIterator] that throws on
    // first `next()`. Equivalent to an async generator that throws
    // before its first yield — but biome flags yield-less generators,
    // so we inline the iterator protocol instead.
    const throwingIterable: AsyncIterable<never> = {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next(): Promise<IteratorResult<never>> {
            return Promise.reject(err);
          },
        };
      },
    };
    jest
      .spyOn(proto, method as never)
      .mockImplementation(() => throwingIterable as never);
  } else {
    jest.spyOn(proto, method as never).mockRejectedValue(err as never);
  }
}

describe('wallet-key leakage sweep', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(
    CASES,
  )('$argv.0 never leaks wk_ across all NearlyError shapes', async ({
    argv,
    method,
    iterator,
  }) => {
    for (const shape of ERROR_SHAPES) {
      const err = new NearlyError(shape);
      stub(method, err, iterator ?? false);
      const result = await runCli(argv, { env: ENV });
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toMatch(WK_PATTERN);
      jest.restoreAllMocks();
    }
  });

  test('register never leaks wk_ across all NearlyError shapes', async () => {
    for (const shape of ERROR_SHAPES) {
      const err = new NearlyError(shape);
      jest.spyOn(NearlyClient, 'register').mockRejectedValue(err);
      const result = await runCli(['register'], { env: ENV });
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toMatch(WK_PATTERN);
      jest.restoreAllMocks();
    }
  });
});

// Completeness guards: the `CASES` array is hand-maintained while `COMMANDS`
// in `src/cli/commands/index.ts` is the authoritative dispatch registry.
// A new command added to `COMMANDS` but forgotten in `CASES` would skip the
// leakage sweep silently — these tests force the two to stay in sync at CI
// time instead of deferring the drift to a post-deploy wk_ leak. `register`
// is tested separately above (its stub is on the static factory, not a
// prototype method) so it's allowed to sit outside `CASES`. Same pattern as
// `INVALIDATION_MAP completeness` in `frontend/__tests__/fastdata-write.test.ts`.
describe('CASES completeness vs COMMANDS registry', () => {
  const CASES_COMMANDS = new Set(CASES.map((c) => c.argv[0]));
  const REGISTRY_COMMANDS = new Set(Object.keys(COMMANDS));

  it('every command in COMMANDS is covered by the sweep (register excepted)', () => {
    const missing = [...REGISTRY_COMMANDS].filter(
      (cmd) => cmd !== 'register' && !CASES_COMMANDS.has(cmd),
    );
    expect(missing).toEqual([]);
  });

  it('every entry in CASES is a real command in COMMANDS', () => {
    const stale = [...CASES_COMMANDS].filter(
      (cmd) => !REGISTRY_COMMANDS.has(cmd),
    );
    expect(stale).toEqual([]);
  });
});
