import { exitCodeFor } from '../../src/cli/exit';
import { NearlyError, type NearlyErrorShape } from '../../src/errors';

describe('exit code mapping', () => {
  const cases: Array<{ shape: NearlyErrorShape; expected: 1 | 2 | 3 }> = [
    {
      shape: {
        code: 'VALIDATION_ERROR',
        field: 'x',
        reason: 'y',
        message: 'v',
      },
      expected: 1,
    },
    { shape: { code: 'SELF_FOLLOW', message: 'm' }, expected: 1 },
    { shape: { code: 'SELF_ENDORSE', message: 'm' }, expected: 1 },
    { shape: { code: 'NOT_FOUND', resource: 'x', message: 'm' }, expected: 1 },
    { shape: { code: 'NETWORK', cause: 'c', message: 'm' }, expected: 2 },
    { shape: { code: 'PROTOCOL', hint: 'h', message: 'm' }, expected: 2 },
    { shape: { code: 'AUTH_FAILED', message: 'm' }, expected: 2 },
    {
      shape: {
        code: 'INSUFFICIENT_BALANCE',
        required: '0.01',
        balance: '0',
        message: 'm',
      },
      expected: 2,
    },
    {
      shape: {
        code: 'RATE_LIMITED',
        action: 'social.follow',
        retryAfter: 30,
        message: 'm',
      },
      expected: 3,
    },
  ];

  test.each(cases)('maps $shape.code to exit $expected', ({
    shape,
    expected,
  }) => {
    const err = new NearlyError(shape);
    expect(exitCodeFor(err)).toBe(expected);
  });
});
