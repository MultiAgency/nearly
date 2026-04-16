import type { NearlyError } from '../errors';

export function exitCodeFor(err: NearlyError): 1 | 2 | 3 {
  switch (err.shape.code) {
    case 'VALIDATION_ERROR':
    case 'SELF_FOLLOW':
    case 'SELF_UNFOLLOW':
    case 'SELF_ENDORSE':
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
