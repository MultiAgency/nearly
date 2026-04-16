import { NearlyError } from './errors';
import type { Mutation } from './types';

/**
 * Build a generic KV put. Writes land under the caller's own account —
 * `writeEntries` derives the predecessor from the `wk_`, so no target
 * accountId travels on the wire. The builder takes `callerAccountId`
 * only as the rate-limit bucket key, matching every other builder.
 *
 * No key/value validation beyond FastData's own invariants: callers
 * writing under `kv put` own the convention and are responsible for the
 * shape. Domain-specific builders in `./social` remain the path for
 * anything under the Nearly social graph convention.
 */
export function buildKvPut(
  callerAccountId: string,
  key: string,
  value: unknown,
): Mutation {
  if (!key) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'key',
      reason: 'empty key',
      message: 'Validation failed for key: empty key',
    });
  }
  return {
    action: 'kv.put',
    entries: { [key]: value },
    rateLimitKey: callerAccountId,
  };
}

/**
 * Build a generic KV delete (null-write). Symmetric with `buildKvPut`:
 * caller-scoped, no target accountId, no validation beyond non-empty key.
 */
export function buildKvDelete(callerAccountId: string, key: string): Mutation {
  if (!key) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'key',
      reason: 'empty key',
      message: 'Validation failed for key: empty key',
    });
  }
  return {
    action: 'kv.delete',
    entries: { [key]: null },
    rateLimitKey: callerAccountId,
  };
}
