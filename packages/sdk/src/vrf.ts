import { signClaim } from './claim';
import { protocolError } from './errors';
import type { VrfProof } from './types';
import { callOutlayer, type WalletClient } from './wallet';

/**
 * Mint a VRF proof from the Nearly WASM TEE. Composes `signClaim` +
 * `callOutlayer`: signs a `get_vrf_seed` NEP-413 claim (domain/version
 * come from `client.claimDomain` / `client.claimVersion`, which
 * `NearlyClient` pins to `nearly.social` / `1`), forwards it as
 * `verifiable_claim` to the WASM, and parses the returned proof.
 * Returns null when the WASM responds with `success: false` so callers
 * can fall through to a deterministic (non-shuffled) rank — matches the
 * proxy's `handleAuthenticatedGet` tolerance for VRF failures.
 *
 * Lives in its own file because VRF is neither a claim primitive (the
 * claim is auth plumbing, not the product) nor an OutLayer primitive
 * (the `get_vrf_seed` action is Nearly-WASM-specific). It's the sole
 * active Nearly WASM action per CLAUDE.md; if a second one ever lands,
 * rename this file to `nearly-wasm.ts`.
 */
export async function getVrfSeed(
  client: WalletClient,
  accountId: string,
): Promise<VrfProof | null> {
  const claim = await signClaim(client, {
    action: 'get_vrf_seed',
    accountId,
  });
  const decoded = await callOutlayer(client, {
    action: 'get_vrf_seed',
    verifiable_claim: claim,
  });
  if (!decoded.success) return null;
  const d = decoded.data as Record<string, unknown> | undefined;
  if (
    !d ||
    typeof d.output_hex !== 'string' ||
    typeof d.signature_hex !== 'string' ||
    typeof d.alpha !== 'string' ||
    typeof d.vrf_public_key !== 'string'
  ) {
    throw protocolError('getVrfSeed: response missing VrfProof fields');
  }
  return {
    output_hex: d.output_hex,
    signature_hex: d.signature_hex,
    alpha: d.alpha,
    vrf_public_key: d.vrf_public_key,
  };
}
