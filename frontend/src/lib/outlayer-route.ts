/**
 * Shared server-side helpers for OutLayer route handlers.
 * Only imported by /api/v1 route — never in client bundles.
 */
import { NextResponse } from 'next/server';
import { PUBLIC_FIELDS } from '@/lib/api-constants';
import { fetchWithTimeout } from '@/lib/fetch';
import { decodeOutlayerResponse } from '@/lib/outlayer-exec';

export const OUTLAYER_PAYMENT_KEY = process.env.OUTLAYER_PAYMENT_KEY || '';
export const OUTLAYER_API_URL =
  process.env.NEXT_PUBLIC_OUTLAYER_API_URL ||
  'https://api.outlayer.fastnear.com';
export const PROJECT_OWNER =
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_OWNER || '';
export const PROJECT_NAME =
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_NAME || 'nearly';

/** Strip verifiable_claim and unknown fields to prevent nonce-burning or parameter injection. */
export function sanitizePublic(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!PUBLIC_FIELDS.has(key)) continue;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      clean[key] = value;
    }
  }
  return clean;
}

/** Call the OutLayer /call endpoint and return a NextResponse.
 *  - `wk_` keys are forwarded as `Authorization: Bearer` (custody wallet auth).
 *  - `owner:nonce:secret` keys are forwarded as `X-Payment-Key` (project payment key).
 */
export async function callOutlayer(
  wasmBody: Record<string, unknown>,
  authKey: string,
): Promise<NextResponse> {
  const url = `${OUTLAYER_API_URL}/call/${PROJECT_OWNER}/${PROJECT_NAME}`;

  const isWalletKey = authKey.startsWith('wk_');
  const authHeaders: Record<string, string> = isWalletKey
    ? { Authorization: `Bearer ${authKey}` }
    : { 'X-Payment-Key': authKey };

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ input: wasmBody }),
      },
      15_000,
    );
  } catch {
    return NextResponse.json(
      { success: false, error: 'Upstream timeout' },
      { status: 504 },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { success: false, error: `Upstream error: ${response.status}` },
      {
        status:
          response.status >= 400 && response.status < 500
            ? response.status
            : 502,
      },
    );
  }

  const result = await response.json();

  try {
    const decoded = decodeOutlayerResponse(result);
    return NextResponse.json(decoded, {
      status: decoded.success ? 200 : 400,
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to decode WASM output' },
      { status: 502 },
    );
  }
}
