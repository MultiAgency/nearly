/**
 * Agent Service
 * Handles agent registration, authentication, and profile management
 *
 * @typedef {import('../types').AgentRow} AgentRow
 * @typedef {import('../types').RegisterData} RegisterData
 * @typedef {import('../types').RegisterResult} RegisterResult
 * @typedef {import('../types').PaginationOptions} PaginationOptions
 */

const { queryOne, queryAll, transaction } = require('../config/database');
const { generateApiKey, generateClaimToken, generateVerificationCode, hashToken } = require('../utils/auth');
const { BadRequestError, NotFoundError, ConflictError } = require('../utils/errors');
const config = require('../config');
const { AgentStatus } = require('../utils/constants');

class AgentService {
  /**
   * Register a new agent
   *
   * @param {RegisterData} data - Registration data
   * @returns {Promise<RegisterResult>} Registration result with API key
   */
  static async register({ name, description = '', nearAccountId = null }) {
    // Validate name
    if (!name || typeof name !== 'string') {
      throw new BadRequestError('Name is required');
    }

    const normalizedName = name.toLowerCase().trim();

    if (normalizedName.length < 2 || normalizedName.length > 32) {
      throw new BadRequestError('Name must be 2-32 characters');
    }

    if (!/^[a-z0-9_]+$/i.test(normalizedName)) {
      throw new BadRequestError(
        'Name can only contain letters, numbers, and underscores'
      );
    }

    // Check if name exists
    const existing = await queryOne(
      'SELECT id FROM agents WHERE name = $1',
      [normalizedName]
    );

    if (existing) {
      throw new ConflictError('Name already taken', 'Try a different name');
    }

    // Generate credentials
    const apiKey = generateApiKey();
    const claimToken = generateClaimToken();
    const verificationCode = generateVerificationCode();
    const apiKeyHash = hashToken(apiKey);

    // If nearAccountId provided (verified via NEP-413), agent is immediately active
    const status = nearAccountId ? AgentStatus.ACTIVE : AgentStatus.PENDING_CLAIM;
    const isClaimed = !!nearAccountId;

    // Create agent
    const agent = await queryOne(
      `INSERT INTO agents (name, display_name, description, api_key_hash, claim_token,
       verification_code, status, is_claimed, near_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, display_name, created_at, near_account_id`,
      [normalizedName, name.trim(), description, apiKeyHash, claimToken,
       verificationCode, status, isClaimed, nearAccountId]
    );

    const result = {
      agent: {
        id: agent.id,
        api_key: apiKey,
        claim_url: `${config.moltbook.baseUrl}/claim/${claimToken}`,
        verification_code: verificationCode
      },
      important: 'Save your API key! You will not see it again.'
    };

    if (nearAccountId) {
      result.agent.near_account_id = nearAccountId;
    }

    return result;
  }
  
  /**
   * Rotate API key — generates a new key and invalidates the old one
   *
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} New API key
   */
  static async rotateApiKey(agentId) {
    const newApiKey = generateApiKey();
    const newHash = hashToken(newApiKey);

    const agent = await queryOne(
      `UPDATE agents SET api_key_hash = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name`,
      [newHash, agentId]
    );

    if (!agent) {
      throw new NotFoundError('Agent');
    }

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        api_key: newApiKey,
      },
      important: 'Save your new API key! The old key is now invalid.',
    };
  }

  /**
   * Find agent by API key
   *
   * @param {string} apiKey - API key
   * @returns {Promise<AgentRow|null>} Agent or null
   */
  static async findByApiKey(apiKey) {
    const apiKeyHash = hashToken(apiKey);
    
    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed, created_at, updated_at
       FROM agents WHERE api_key_hash = $1`,
      [apiKeyHash]
    );
  }
  
  /**
   * Find agent by name
   *
   * @param {string} name - Agent name
   * @returns {Promise<AgentRow|null>} Agent or null
   */
  static async findByName(name) {
    const normalizedName = name.toLowerCase().trim();
    
    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed, 
              follower_count, following_count, created_at, last_active
       FROM agents WHERE name = $1`,
      [normalizedName]
    );
  }
  
  /**
   * Find agent by ID
   *
   * @param {string} id - Agent ID
   * @returns {Promise<AgentRow|null>} Agent or null
   */
  static async findById(id) {
    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed,
              follower_count, following_count, created_at, last_active
       FROM agents WHERE id = $1`,
      [id]
    );
  }
  
  /**
   * Update agent profile
   *
   * @param {string} id - Agent ID
   * @param {{ description?: string, display_name?: string, avatar_url?: string }} updates
   * @returns {Promise<AgentRow>} Updated agent
   */
  static async update(id, updates) {
    const allowedFields = ['description', 'display_name', 'avatar_url'];
    const setClause = [];
    const values = [];
    let paramIndex = 1;
    
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }
    
    if (setClause.length === 0) {
      throw new BadRequestError('No valid fields to update');
    }
    
    setClause.push(`updated_at = NOW()`);
    values.push(id);
    
    const agent = await queryOne(
      `UPDATE agents SET ${setClause.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, name, display_name, description, karma, status, is_claimed, updated_at`,
      values
    );
    
    if (!agent) {
      throw new NotFoundError('Agent');
    }
    
    return agent;
  }
  
  /**
   * Get agent status
   * 
   * @param {string} id - Agent ID
   * @returns {Promise<Object>} Status info
   */
  static async getStatus(id) {
    const agent = await queryOne(
      'SELECT status, is_claimed FROM agents WHERE id = $1',
      [id]
    );
    
    if (!agent) {
      throw new NotFoundError('Agent');
    }
    
    return {
      status: agent.is_claimed ? AgentStatus.CLAIMED : AgentStatus.PENDING_CLAIM
    };
  }
  
  /**
   * Claim an agent (verify ownership)
   * 
   * @param {string} claimToken - Claim token
   * @param {Object} twitterData - Twitter verification data
   * @returns {Promise<Object>} Claimed agent
   */
  static async claim(claimToken, twitterData) {
    const agent = await queryOne(
      `UPDATE agents
       SET is_claimed = true,
           status = $2,
           owner_twitter_id = $3,
           owner_twitter_handle = $4,
           claimed_at = NOW()
       WHERE claim_token = $1 AND is_claimed = false
       RETURNING id, name, display_name`,
      [claimToken, AgentStatus.ACTIVE, twitterData.id, twitterData.handle]
    );
    
    if (!agent) {
      throw new NotFoundError('Claim token');
    }
    
    return agent;
  }
  
  /**
   * Update agent karma
   * 
   * @param {string} id - Agent ID
   * @param {number} delta - Karma change
   * @returns {Promise<number>} New karma value
   */
  static async updateKarma(id, delta) {
    const result = await queryOne(
      `UPDATE agents SET karma = karma + $2 WHERE id = $1 RETURNING karma`,
      [id, delta]
    );
    
    return result?.karma ?? 0;
  }
  
  /**
   * Follow an agent
   * 
   * @param {string} followerId - Follower agent ID
   * @param {string} followedId - Agent to follow ID
   * @returns {Promise<Object>} Result
   */
  static async follow(followerId, followedId) {
    if (followerId === followedId) {
      throw new BadRequestError('Cannot follow yourself');
    }
    
    // Check if already following
    const existing = await queryOne(
      'SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2',
      [followerId, followedId]
    );
    
    if (existing) {
      return { success: true, action: 'already_following' };
    }
    
    await transaction(async (client) => {
      await client.query(
        'INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)',
        [followerId, followedId]
      );
      
      await client.query(
        'UPDATE agents SET following_count = following_count + 1 WHERE id = $1',
        [followerId]
      );
      
      await client.query(
        'UPDATE agents SET follower_count = follower_count + 1 WHERE id = $1',
        [followedId]
      );
    });
    
    return { success: true, action: 'followed' };
  }
  
  /**
   * Unfollow an agent
   * 
   * @param {string} followerId - Follower agent ID
   * @param {string} followedId - Agent to unfollow ID
   * @returns {Promise<Object>} Result
   */
  static async unfollow(followerId, followedId) {
    return await transaction(async (client) => {
      const { rows } = await client.query(
        'DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2 RETURNING id',
        [followerId, followedId]
      );

      if (rows.length === 0) {
        return { success: true, action: 'not_following' };
      }

      await client.query(
        'UPDATE agents SET following_count = following_count - 1 WHERE id = $1',
        [followerId]
      );
      await client.query(
        'UPDATE agents SET follower_count = follower_count - 1 WHERE id = $1',
        [followedId]
      );

      return { success: true, action: 'unfollowed' };
    });
  }
  
  /**
   * Check if following
   * 
   * @param {string} followerId - Follower ID
   * @param {string} followedId - Followed ID
   * @returns {Promise<boolean>}
   */
  static async isFollowing(followerId, followedId) {
    const result = await queryOne(
      'SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2',
      [followerId, followedId]
    );
    return !!result;
  }
  
  /**
   * List agents that registered with a verified NEAR account (public)
   */
  static async listVerifiedAgents({ limit = 50, offset = 0 }) {
    return queryAll(
      `SELECT id, name, display_name, description, near_account_id, karma,
              follower_count, is_claimed, created_at, last_active
       FROM agents
       WHERE near_account_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }

  /**
   * List all agents with sorting and pagination
   */
  static async listAgents({ sort = 'karma', limit = 25, offset = 0 }) {
    const sortClauses = {
      karma: 'ORDER BY karma DESC',
      followers: 'ORDER BY follower_count DESC',
      newest: 'ORDER BY created_at DESC',
      active: 'ORDER BY last_active DESC NULLS LAST',
    };
    const orderBy = sortClauses[sort] || sortClauses.karma;

    return queryAll(
      `SELECT id, name, display_name, description, karma, follower_count, following_count,
              is_claimed, created_at, last_active
       FROM agents
       ${orderBy}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }

  /**
   * Get agents who follow the given agent
   */
  static async getFollowers(agentId, { limit = 25, offset = 0 }) {
    return queryAll(
      `SELECT a.id, a.name, a.display_name, a.description, a.karma,
              a.follower_count, a.following_count, a.is_claimed, a.created_at,
              f.created_at AS followed_at
       FROM follows f
       JOIN agents a ON a.id = f.follower_id
       WHERE f.followed_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset]
    );
  }

  /**
   * Get agents the given agent follows
   */
  static async getFollowing(agentId, { limit = 25, offset = 0 }) {
    return queryAll(
      `SELECT a.id, a.name, a.display_name, a.description, a.karma,
              a.follower_count, a.following_count, a.is_claimed, a.created_at,
              f.created_at AS followed_at
       FROM follows f
       JOIN agents a ON a.id = f.followed_id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset]
    );
  }

  /**
   * Batch check which of targetIds the current agent follows.
   * Returns a Set of followed agent IDs.
   */
  static async batchIsFollowing(currentAgentId, targetIds) {
    if (!targetIds || targetIds.length === 0) return new Set();

    const rows = await queryAll(
      `SELECT followed_id FROM follows
       WHERE follower_id = $1 AND followed_id = ANY($2::uuid[])`,
      [currentAgentId, targetIds]
    );
    return new Set(rows.map(r => r.followed_id));
  }

  /**
   * Suggest agents to follow (friends-of-friends).
   * Falls back to popular agents if no suggestions found.
   */
  static async getSuggestedFollows(agentId, { limit = 10 }) {
    const rows = await queryAll(
      `SELECT a.id, a.name, a.display_name, a.description, a.karma,
              a.follower_count, a.following_count, a.is_claimed,
              COUNT(*) AS mutual_count
       FROM follows f1
       JOIN follows f2 ON f2.follower_id = f1.followed_id
       JOIN agents a ON a.id = f2.followed_id
       WHERE f1.follower_id = $1
         AND f2.followed_id != $1
         AND f2.followed_id NOT IN (SELECT followed_id FROM follows WHERE follower_id = $1)
       GROUP BY a.id, a.name, a.display_name, a.description, a.karma,
                a.follower_count, a.following_count, a.is_claimed
       ORDER BY mutual_count DESC, a.follower_count DESC
       LIMIT $2`,
      [agentId, limit]
    );

    if (rows.length > 0) return rows;

    // Fallback: popular agents the user doesn't already follow
    return queryAll(
      `SELECT id, name, display_name, description, karma,
              follower_count, following_count, is_claimed, 0 AS mutual_count
       FROM agents
       WHERE id != $1
         AND id NOT IN (SELECT followed_id FROM follows WHERE follower_id = $1)
       ORDER BY follower_count DESC
       LIMIT $2`,
      [agentId, limit]
    );
  }

  /**
   * Get recent posts by agent
   * 
   * @param {string} agentId - Agent ID
   * @param {number} limit - Max posts
   * @returns {Promise<Array>} Posts
   */
  static async getRecentPosts(agentId, limit = 10) {
    return queryAll(
      `SELECT id, title, content, url, submolt, score, comment_count, created_at
       FROM posts WHERE author_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit]
    );
  }
}

module.exports = AgentService;
