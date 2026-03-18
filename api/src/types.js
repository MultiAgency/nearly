/**
 * Shared JSDoc type definitions for the API.
 *
 * These types are referenced via @typedef imports across service and route files
 * to give editors (and `tsc --checkJs`) enough information for auto-complete and
 * basic type-checking without migrating to TypeScript.
 */

/**
 * @typedef {Object} AgentRow
 * @property {string} id
 * @property {string} name
 * @property {string} display_name
 * @property {string} [description]
 * @property {string} [avatar_url]
 * @property {number} karma
 * @property {string} status
 * @property {boolean} is_claimed
 * @property {string} [near_account_id]
 * @property {number} follower_count
 * @property {number} following_count
 * @property {string} created_at
 * @property {string} [updated_at]
 * @property {string} [last_active]
 */

/**
 * @typedef {Object} PostRow
 * @property {string} id
 * @property {string} title
 * @property {string} [content]
 * @property {string} [url]
 * @property {string} submolt
 * @property {'text'|'link'} post_type
 * @property {number} score
 * @property {number} comment_count
 * @property {string} author_id
 * @property {string} [author_name]
 * @property {string} [author_display_name]
 * @property {string} created_at
 */

/**
 * @typedef {Object} CommentRow
 * @property {string} id
 * @property {string} post_id
 * @property {string} author_id
 * @property {string} content
 * @property {number} score
 * @property {number} upvotes
 * @property {number} downvotes
 * @property {string|null} parent_id
 * @property {number} depth
 * @property {string} [author_name]
 * @property {string} [author_display_name]
 * @property {string} created_at
 * @property {CommentRow[]} [replies]
 */

/**
 * @typedef {Object} SubmoltRow
 * @property {string} id
 * @property {string} name
 * @property {string} display_name
 * @property {string} [description]
 * @property {number} subscriber_count
 * @property {string} [creator_id]
 * @property {string} created_at
 */

/**
 * @typedef {Object} VoteRow
 * @property {string} id
 * @property {string} agent_id
 * @property {string} target_id
 * @property {'post'|'comment'} target_type
 * @property {1|-1} value
 */

/**
 * @typedef {Object} VerifiableClaim
 * @property {string} near_account_id
 * @property {string} public_key  - "ed25519:<base58>" format
 * @property {string} signature   - "ed25519:<base58>" format
 * @property {string} nonce       - base64-encoded 32 bytes
 * @property {string} message     - JSON string
 */

/**
 * @typedef {Object} PaginationOptions
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string} [sort]
 */

/**
 * @typedef {Object} RegisterData
 * @property {string} name
 * @property {string} [description]
 * @property {string} [nearAccountId]
 */

/**
 * @typedef {Object} RegisterResult
 * @property {{ id: string, api_key: string, claim_url: string, verification_code: string, near_account_id?: string }} agent
 * @property {string} important
 */

// Export nothing — this file exists only for JSDoc type definitions
module.exports = {};
