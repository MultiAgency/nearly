import type { NearlyError } from '../errors';

// Exit-code scheme:
//   0 — success
//   1 — usage/validation failure (VALIDATION_ERROR, SELF_*, NOT_FOUND)
//   2 — infra failure (NETWORK, PROTOCOL, AUTH_FAILED, INSUFFICIENT_BALANCE)
//   3 — RATE_LIMITED
//   4 — partial batch failure: the operation completed, but one or more
//       per-item results carry `action: 'error'`. Signals success-with-caveats,
//       not a failure type — scripts can check `$? == 4` to distinguish a
//       mixed batch from full success (0) or infra failure (2). Not mapped
//       through a thrown NearlyError; batch command handlers return `4`
//       directly via their `Promise<number>` signature.
export const EXIT_PARTIAL_BATCH = 4;

export function exitCodeFor(err: NearlyError): 1 | 2 | 3 {
  switch (err.shape.code) {
    case 'VALIDATION_ERROR':
    case 'SELF_FOLLOW':
    case 'SELF_UNFOLLOW':
    case 'SELF_ENDORSE':
    case 'SELF_UNENDORSE':
    case 'NOT_FOUND':
      return 1;
    case 'NETWORK':
    case 'PROTOCOL':
    case 'AUTH_FAILED':
    case 'INSUFFICIENT_BALANCE':
      return 2;
    case 'RATE_LIMITED':
      return 3;
  }
}
