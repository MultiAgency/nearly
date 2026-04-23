/**
 * Next.js startup hook — fires once per worker at boot.
 *
 * Tripwire for the single-instance deployment assumption documented in
 * CLAUDE.md. The in-memory `nonceStore` (NEP-413 replay protection),
 * TTL `cache`, and `accountCache` are all per-process; multi-replica
 * deployments silently lose replay protection within the freshness
 * window. Detecting multi-replica from inside a single process isn't
 * possible without infrastructure, so this guards the documented path:
 * an operator who reads the CLAUDE.md note and tries to enable
 * multi-replica via env var gets a fail-loud error instead of a silent
 * security-boundary hole. `replicas: 2` without setting the env var
 * remains protected only by the architecture note itself.
 */
export function register(): void {
  const raw = process.env.NEARLY_DEPLOYMENT;
  if (raw === undefined || raw === '' || raw === 'single') return;
  if (raw === 'multi') {
    throw new Error(
      'NEARLY_DEPLOYMENT=multi rejected at boot: this build relies on a per-process `nonceStore` for NEP-413 replay protection (frontend/src/lib/verify-claim.ts). Multi-replica deployments would accept replayed signatures across pods within the freshness window. Implement a shared nonceStore backend before re-setting NEARLY_DEPLOYMENT=multi.',
    );
  }
  throw new Error(
    `NEARLY_DEPLOYMENT=${raw} is not a recognized value. Allowed: unset, 'single', 'multi' (the last is rejected — see frontend/src/instrumentation.ts).`,
  );
}
