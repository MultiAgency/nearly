import {
  DEFAULT_TIMEOUT_MS,
  FASTDATA_MAX_PAGES,
  FASTDATA_PAGE_SIZE,
} from './constants';
import { networkError, protocolError } from './errors';
import type { KvEntry, KvListResponse } from './types';

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ReadTransport {
  fastdataUrl: string;
  namespace: string;
  fetch: FetchLike;
  timeoutMs: number;
}

export function createReadTransport(opts: {
  fastdataUrl: string;
  namespace: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): ReadTransport {
  return {
    fastdataUrl: opts.fastdataUrl,
    namespace: opts.namespace,
    fetch: opts.fetch ?? (globalThis.fetch as FetchLike),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function withTimeout(
  transport: ReadTransport,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), transport.timeoutMs);
  try {
    return await transport.fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }
}

function isLive(e: KvEntry): boolean {
  return e.value !== null && e.value !== undefined && e.value !== '';
}

/**
 * Read a single key for a known agent. Returns the raw KvEntry, or null if
 * the key is missing or tombstoned. Domain interpretation belongs in graph.ts.
 */
export async function kvGetKey(
  transport: ReadTransport,
  accountId: string,
  key: string,
): Promise<KvEntry | null> {
  const url = `${transport.fastdataUrl}/v0/latest/${transport.namespace}/${accountId}/${key}`;
  const res = await withTimeout(transport, url);
  if (res.status === 404) return null;
  if (!res.ok) throw protocolError(`kvGetKey ${res.status}`);
  let data: KvListResponse;
  try {
    data = (await res.json()) as KvListResponse;
  } catch {
    throw protocolError('kvGetKey: malformed JSON');
  }
  const entry = data.entries?.[0];
  return entry && isLive(entry) ? entry : null;
}

/**
 * Generic paginated POST against FastData KV, yielding live entries lazily.
 * Stops when page_token is absent or the optional caller limit is reached.
 */
export async function* kvPaginate(
  transport: ReadTransport,
  url: string,
  baseBody: Record<string, unknown>,
  limit?: number,
): AsyncIterable<KvEntry> {
  let pageToken: string | undefined;
  let yielded = 0;
  for (let i = 0; i < FASTDATA_MAX_PAGES; i++) {
    const body = pageToken ? { ...baseBody, page_token: pageToken } : baseBody;
    const res = await withTimeout(transport, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw protocolError(`kvPaginate ${res.status}`);
    let data: KvListResponse;
    try {
      data = (await res.json()) as KvListResponse;
    } catch {
      throw protocolError('kvPaginate: malformed JSON');
    }
    for (const e of data.entries ?? []) {
      if (!isLive(e)) continue;
      yield e;
      yielded++;
      if (limit !== undefined && yielded >= limit) return;
    }
    if (!data.page_token) return;
    pageToken = data.page_token;
  }
}

/**
 * Prefix scan for a known agent's keys. Yields entries lazily.
 */
export function kvListAgent(
  transport: ReadTransport,
  accountId: string,
  prefix: string,
  limit?: number,
): AsyncIterable<KvEntry> {
  const url = `${transport.fastdataUrl}/v0/latest/${transport.namespace}/${accountId}`;
  const body: Record<string, unknown> = {
    key_prefix: prefix,
    limit: limit ?? FASTDATA_PAGE_SIZE,
  };
  return kvPaginate(transport, url, body, limit);
}

/**
 * Read a single key across all predecessors in the namespace. One entry per
 * agent who has written the key. Used for `kvGetAllKey('profile')` (all
 * profiles in the directory) and `kvGetAllKey('graph/follow/{id}')` (all
 * predecessors following an agent).
 */
export function kvGetAllKey(
  transport: ReadTransport,
  key: string,
  limit?: number,
): AsyncIterable<KvEntry> {
  const url = `${transport.fastdataUrl}/v0/latest/${transport.namespace}`;
  return kvPaginate(
    transport,
    url,
    { key, limit: limit ?? FASTDATA_PAGE_SIZE },
    limit,
  );
}

/**
 * Prefix scan across all predecessors in the namespace. Used for
 * `kvListAllPrefix('tag/{tag}')`, `kvListAllPrefix('cap/{ns}/{value}')`,
 * and `kvListAllPrefix('endorsing/{target}/')`.
 */
export function kvListAllPrefix(
  transport: ReadTransport,
  prefix: string,
  limit?: number,
): AsyncIterable<KvEntry> {
  const url = `${transport.fastdataUrl}/v0/latest/${transport.namespace}`;
  return kvPaginate(
    transport,
    url,
    { key_prefix: prefix, limit: limit ?? FASTDATA_PAGE_SIZE },
    limit,
  );
}

/**
 * Fetch the FIRST historical write of a key for a known agent via
 * `/v0/history/{NS}/{accountId}/{key}` with `asc=true, limit=1`. Returns
 * null when no history exists. The entry's `block_timestamp` is the
 * block-authoritative `created_at` for that key.
 */
export async function kvGetAgentFirstWrite(
  transport: ReadTransport,
  accountId: string,
  key: string,
): Promise<KvEntry | null> {
  const url = `${transport.fastdataUrl}/v0/history/${transport.namespace}/${accountId}/${key}`;
  const res = await withTimeout(transport, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asc: true, limit: 1 }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw protocolError(`kvGetAgentFirstWrite ${res.status}`);
  let data: KvListResponse;
  try {
    data = (await res.json()) as KvListResponse;
  } catch {
    throw protocolError('kvGetAgentFirstWrite: malformed JSON');
  }
  return data.entries?.[0] ?? null;
}

/**
 * Walk the namespace-wide history of a key in ascending order and return
 * the FIRST write per predecessor. Used by `sort=newest` to derive each
 * agent's block-authoritative `created_at` in one paginated call instead
 * of N per-agent fetches.
 *
 * Scale cap matches the frontend: `FASTDATA_MAX_PAGES * FASTDATA_PAGE_SIZE`
 * entries max. Agents whose first write is older than the most recent
 * window silently drop out of the map and sort last under `sort=newest`.
 */
export async function kvHistoryFirstByPredecessor(
  transport: ReadTransport,
  key: string,
): Promise<Map<string, KvEntry>> {
  const url = `${transport.fastdataUrl}/v0/history/${transport.namespace}`;
  const firstByAgent = new Map<string, KvEntry>();
  let pageToken: string | undefined;
  for (let i = 0; i < FASTDATA_MAX_PAGES; i++) {
    const body: Record<string, unknown> = {
      key,
      asc: true,
      limit: FASTDATA_PAGE_SIZE,
    };
    if (pageToken) body.page_token = pageToken;
    const res = await withTimeout(transport, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw protocolError(`kvHistoryFirstByPredecessor ${res.status}`);
    let data: KvListResponse;
    try {
      data = (await res.json()) as KvListResponse;
    } catch {
      throw protocolError('kvHistoryFirstByPredecessor: malformed JSON');
    }
    for (const e of data.entries ?? []) {
      if (!firstByAgent.has(e.predecessor_id)) {
        firstByAgent.set(e.predecessor_id, e);
      }
    }
    if (!data.page_token) break;
    pageToken = data.page_token;
  }
  return firstByAgent;
}
