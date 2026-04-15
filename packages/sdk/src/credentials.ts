import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { NearlyError, sanitizeErrorDetail } from './errors';

/**
 * One stored agent credential record. `api_key` and `account_id` are the
 * minimum viable pair to reconstruct a `NearlyClient`; `platforms` is a
 * free-form bag for per-platform extensions; any other unknown fields
 * already in the file are preserved verbatim on round-trip so third
 * parties can extend the record without collision.
 */
export interface StoredAccount {
  api_key: string;
  account_id: string;
  platforms?: Record<string, unknown>;
  [extra: string]: unknown;
}

/**
 * On-disk shape of `~/.config/nearly/credentials.json`. Multi-agent by
 * design: one root file holds N entries keyed by NEAR account ID so a
 * swarm of sub-agents derived from one root wallet can live side-by-side.
 */
export interface CredentialsFile {
  accounts: Record<string, StoredAccount>;
}

const DEFAULT_REL_DIR = '.config/nearly';
const DEFAULT_FILE_NAME = 'credentials.json';

function defaultPath(): string {
  return join(homedir(), DEFAULT_REL_DIR, DEFAULT_FILE_NAME);
}

function errCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Read the credentials file at `path` (default
 * `~/.config/nearly/credentials.json`). Returns `null` when the file
 * does not exist — callers treat that as an empty file to start from.
 *
 * Throws `NearlyError { code: 'PROTOCOL' }` on malformed JSON or a
 * structurally-invalid top-level shape (non-object `accounts`). No
 * per-field schema validation beyond that — unknown fields on stored
 * accounts pass through untouched, which is the whole point of the
 * multi-agent merge format.
 */
export async function loadCredentials(
  path?: string,
): Promise<CredentialsFile | null> {
  const filePath = path ?? defaultPath();
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Route through `sanitizeErrorDetail` so a malformed file that happens
    // to contain an unredacted `wk_…` fragment near the parse-error offset
    // cannot leak through the error surface per BUILD.md §4.
    const detail = sanitizeErrorDetail(
      err instanceof Error ? err.message : String(err),
    );
    throw new NearlyError({
      code: 'PROTOCOL',
      hint: `credentials.json parse error: ${detail}`,
      message: `Malformed credentials file at ${filePath}: ${detail}`,
    });
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('accounts' in parsed) ||
    typeof (parsed as { accounts: unknown }).accounts !== 'object' ||
    (parsed as { accounts: unknown }).accounts === null ||
    Array.isArray((parsed as { accounts: unknown }).accounts)
  ) {
    throw new NearlyError({
      code: 'PROTOCOL',
      hint: 'credentials.json missing top-level `accounts` object',
      message: `Malformed credentials file at ${filePath}: expected { accounts: { ... } }`,
    });
  }

  return parsed as CredentialsFile;
}

/**
 * Persist one agent credential entry into the credentials file. Merges
 * into any existing record at `accounts[entry.account_id]`: last-write
 * wins on every field except `api_key`, which throws rather than
 * clobbering if a *different* non-empty value is already stored (wallet
 * keys are never silently rotated — delete the entry explicitly).
 *
 * Writes atomically through a temp file with mode 0o600; creates the
 * parent directory with mode 0o700 on first write. The temp file is
 * unlinked on rename failure so a failed write does not leave a stale
 * `.tmp` sibling in the credentials directory.
 *
 * **Sequential callers see each other's writes on the next load.** This
 * is NOT concurrent-safe: two processes that call `saveCredentials`
 * simultaneously against the same file both read the pre-write state,
 * merge their entries, and rename; whichever rename executes second
 * silently clobbers the first process's entry. The file stays valid
 * JSON — there is no corruption — but a concurrent insertion can be
 * lost. If your flow runs concurrent writes against the same path
 * (parallel CLI invocations, multiple agent processes sharing a
 * credentials file), add an external lock around `saveCredentials` or
 * re-read after every call and retry if your entry isn't present.
 */
export async function saveCredentials(
  entry: StoredAccount,
  path?: string,
): Promise<void> {
  if (!entry.account_id) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'account_id',
      reason: 'required',
      message: 'saveCredentials: entry.account_id is required',
    });
  }
  if (!entry.api_key) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'api_key',
      reason: 'required',
      message: 'saveCredentials: entry.api_key is required',
    });
  }

  const filePath = path ?? defaultPath();
  const dir = dirname(filePath);

  const existing = await loadCredentials(filePath);
  const file: CredentialsFile = existing ?? { accounts: {} };

  const prior = file.accounts[entry.account_id];
  if (prior?.api_key && prior.api_key !== entry.api_key) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'api_key',
      reason: 'already_set',
      message:
        'walletKey already set for this account — delete the entry explicitly to rotate',
    });
  }

  const merged: StoredAccount = {
    ...(prior ?? {}),
    ...entry,
  };
  if (prior?.platforms || entry.platforms) {
    merged.platforms = {
      ...(prior?.platforms ?? {}),
      ...(entry.platforms ?? {}),
    };
  }

  file.accounts[entry.account_id] = merged;

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(file, null, 2), {
    mode: 0o600,
  });
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    // Rename can fail for real reasons (EXDEV cross-device link, EPERM,
    // ENOSPC mid-operation). In every case the tmp file is left behind
    // and a subsequent `ls` of the credentials directory would surface
    // a stale `.tmp` sibling. Clean it up and rethrow the original
    // error — the caller gets the actual failure, not a cleanup error.
    // Unlink's own failure is intentionally swallowed: if the tmp is
    // already gone (race with another process, or the OS cleaned it)
    // the rename failure is still what the caller needs to see.
    try {
      await unlink(tmpPath);
    } catch {
      // Intentionally ignored — see comment above.
    }
    throw err;
  }
}
