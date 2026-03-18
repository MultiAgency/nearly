/**
 * Middleware: Validate Verifiable Claim
 *
 * If req.body.verifiable_claim is present, verifies it and sets
 * req.verifiedNearAccount to the claimed near_account_id.
 * If absent, passes through unchanged (non-breaking).
 */

const NearVerificationService = require('../services/NearVerificationService');

async function validateVerifiableClaim(req, res, next) {
  const { verifiable_claim } = req.body || {};

  if (!verifiable_claim) {
    return next();
  }

  try {
    await NearVerificationService.verifyClaim(verifiable_claim);
    req.verifiedNearAccount = verifiable_claim.near_account_id;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { validateVerifiableClaim };
