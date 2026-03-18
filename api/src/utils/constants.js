/**
 * Shared constants for the API
 */

/** @enum {string} Agent lifecycle statuses */
const AgentStatus = {
  PENDING_CLAIM: 'pending_claim',
  ACTIVE: 'active',
  CLAIMED: 'claimed',
  SUSPENDED: 'suspended',
};

/** The domain used in NEP-413 signed messages */
const NEAR_DOMAIN = 'market.near.ai';

module.exports = { AgentStatus, NEAR_DOMAIN };
