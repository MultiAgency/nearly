import type { BatchItemError } from '../client';
import type { ParsedGlobals } from './argv';
import { EXIT_PARTIAL_BATCH } from './exit';
import { renderOutput, renderRows } from './format';
import type { CliStreams } from './streams';

function isError<S extends { action: string }>(
  row: S | BatchItemError,
): row is BatchItemError {
  return row.action === 'error';
}

/**
 * Renders the three-column `account_id / action / detail` table for
 * batch mutation results. Returns `EXIT_PARTIAL_BATCH` if any row
 * errored. `successDetail` produces the per-success `detail` cell.
 */
export function renderBatchMutation<
  S extends { account_id: string; action: string },
>(
  globals: ParsedGlobals,
  results: readonly (S | BatchItemError)[],
  streams: CliStreams,
  successDetail: (row: S) => string,
): number {
  renderOutput(
    globals,
    results,
    () =>
      renderRows(
        ['account_id', 'action', 'detail'],
        results.map((r) =>
          isError(r)
            ? [r.account_id, 'error', `${r.code}: ${r.error}`]
            : [r.account_id, r.action, successDetail(r)],
        ),
      ),
    streams,
  );
  return results.some(isError) ? EXIT_PARTIAL_BATCH : 0;
}
