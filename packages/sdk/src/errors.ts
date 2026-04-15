export type NearlyErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'SELF_FOLLOW'
  | 'SELF_ENDORSE'
  | 'NOT_FOUND'
  | 'AUTH_FAILED'
  | 'NETWORK'
  | 'PROTOCOL';

interface InsufficientBalanceError {
  code: 'INSUFFICIENT_BALANCE';
  required: string;
  balance: string;
  message: string;
}
interface RateLimitedError {
  code: 'RATE_LIMITED';
  action: string;
  retryAfter: number;
  message: string;
}
interface ValidationErrorShape {
  code: 'VALIDATION_ERROR';
  field: string;
  reason: string;
  message: string;
}
interface SelfFollowError {
  code: 'SELF_FOLLOW';
  message: string;
}
interface SelfEndorseError {
  code: 'SELF_ENDORSE';
  message: string;
}
interface NotFoundError {
  code: 'NOT_FOUND';
  resource: string;
  message: string;
}
interface AuthError {
  code: 'AUTH_FAILED';
  message: string;
}
interface NetworkError {
  code: 'NETWORK';
  /**
   * Sanitized string representation of the underlying cause. Stored as a
   * string (not `unknown`) so the redaction guarantee holds across the
   * full error shape — a raw `Error` or arbitrary object could carry a
   * `wk_` token in a stack trace, a header snapshot, or a custom field
   * and bleed through `JSON.stringify`. Callers who need the raw object
   * for stack correlation should chain from the `NearlyError` itself.
   */
  cause: string;
  message: string;
}
interface ProtocolError {
  code: 'PROTOCOL';
  hint: string;
  message: string;
}

export type NearlyErrorShape =
  | InsufficientBalanceError
  | RateLimitedError
  | ValidationErrorShape
  | SelfFollowError
  | SelfEndorseError
  | NotFoundError
  | AuthError
  | NetworkError
  | ProtocolError;

export class NearlyError extends Error {
  readonly shape: NearlyErrorShape;

  constructor(shape: NearlyErrorShape) {
    super(shape.message);
    this.name = 'NearlyError';
    this.shape = shape;
  }

  get code(): NearlyErrorCode {
    return this.shape.code;
  }
}

/**
 * Redact wk_ custody wallet keys from any string before it enters the
 * error surface. Per BUILD.md §4, wallet keys must never appear in any
 * `message` or other error field — this helper is the funnel every
 * error-construction site routes response bodies, network-layer
 * messages, and other untrusted detail strings through. Preserves a
 * short `[REDACTED_WK]` placeholder so consumers can still tell the
 * original string contained a key; the placeholder itself does not
 * match the `/wk_[A-Za-z0-9_]+/` leak pattern (the leakage sweep test
 * uses a strict match and would flag a placeholder that did).
 *
 * The 200-char cap matches the frontend's error-body truncation and
 * keeps protocol errors readable without risking unbounded leaks from
 * upstream 500 pages. **The cap applies to every detail string this
 * function sees, not just response bodies** — short hints like
 * `'kvPaginate 404'` are unaffected, but a future caller that builds a
 * longer debugging context string will see it silently truncated. Keep
 * protocolError hints concise; if you need to surface a long payload,
 * attach it to a dedicated shape field (like `cause` on `NetworkError`)
 * rather than stuffing it into `hint`.
 */
const WK_KEY_PATTERN = /wk_[A-Za-z0-9_]+/g;
const SAFE_DETAIL_MAX = 200;

export function sanitizeErrorDetail(detail: string): string {
  return detail
    .replace(WK_KEY_PATTERN, '[REDACTED_WK]')
    .slice(0, SAFE_DETAIL_MAX);
}

export function validationError(field: string, reason: string): NearlyError {
  // Defensive: every current call site passes structural literals (field
  // names like 'seed' / 'api_key', reason strings like 'must not be empty'),
  // but sanitize on the way in so the whole error constructor family has
  // the same wk_-never-in-messages guarantee. Symmetric with
  // authError/networkError/protocolError.
  const safeField = sanitizeErrorDetail(field);
  const safeReason = sanitizeErrorDetail(reason);
  return new NearlyError({
    code: 'VALIDATION_ERROR',
    field: safeField,
    reason: safeReason,
    message: `Validation failed for ${safeField}: ${safeReason}`,
  });
}

export function networkError(cause: unknown): NearlyError {
  const rawDetail = cause instanceof Error ? cause.message : String(cause);
  const safeDetail = sanitizeErrorDetail(rawDetail);
  return new NearlyError({
    code: 'NETWORK',
    cause: safeDetail,
    message: `Network error: ${safeDetail}`,
  });
}

export function protocolError(hint: string): NearlyError {
  const safeHint = sanitizeErrorDetail(hint);
  return new NearlyError({
    code: 'PROTOCOL',
    hint: safeHint,
    message: `Protocol error: ${safeHint}`,
  });
}

export function rateLimitedError(
  action: string,
  retryAfter: number,
): NearlyError {
  // `action` is controlled (a `MutationAction` enum today), but sanitize
  // on the way in so a future caller that interpolates user-sourced data
  // can't leak a wk_ through the error surface.
  const safeAction = sanitizeErrorDetail(action);
  return new NearlyError({
    code: 'RATE_LIMITED',
    action: safeAction,
    retryAfter,
    message: `Rate limit exceeded for ${safeAction}. Retry after ${retryAfter}s.`,
  });
}

export function insufficientBalanceError(
  required: string,
  balance: string,
): NearlyError {
  // Defensive: every current call site passes numeric strings from an
  // OutLayer response (required='0.01', balance='0'), but sanitize for
  // symmetry with the rest of the error constructor family. Keeps the
  // wk_-never-in-messages guarantee airtight across every surface.
  const safeRequired = sanitizeErrorDetail(required);
  const safeBalance = sanitizeErrorDetail(balance);
  return new NearlyError({
    code: 'INSUFFICIENT_BALANCE',
    required: safeRequired,
    balance: safeBalance,
    message: `Insufficient balance: required ≥${safeRequired} NEAR, current balance ${safeBalance}. Fund your custody wallet and retry.`,
  });
}

export function authError(message: string): NearlyError {
  // Defensive: `message` is hardcoded at every current call site, but the
  // signature accepts an arbitrary string and a future caller that
  // interpolates a response body here must not leak a wk_ through the
  // error. Route through the same funnel as networkError/protocolError.
  const safeMessage = sanitizeErrorDetail(message);
  return new NearlyError({ code: 'AUTH_FAILED', message: safeMessage });
}

export function notFoundError(resource: string): NearlyError {
  const safeResource = sanitizeErrorDetail(resource);
  return new NearlyError({
    code: 'NOT_FOUND',
    resource: safeResource,
    message: `Not found: ${safeResource}`,
  });
}
