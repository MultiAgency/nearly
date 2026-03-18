/**
 * Agent Routes
 * /api/v1/agents/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { success, created, paginated } = require('../utils/response');
const AgentService = require('../services/AgentService');
const { NotFoundError } = require('../utils/errors');
const { validateVerifiableClaim } = require('../middleware/validateVerifiableClaim');
const { registrationLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { registerAgentSchema } = require('../schemas');
const config = require('../config');

const router = Router();

// Helper: decorate agent rows with camelCase keys + isFollowing
function decorateAgents(agents, followingSet) {
  return agents.map(a => ({
    name: a.name,
    displayName: a.display_name,
    description: a.description,
    karma: a.karma,
    followerCount: a.follower_count,
    followingCount: a.following_count,
    isClaimed: a.is_claimed,
    createdAt: a.created_at,
    lastActive: a.last_active,
    isFollowing: followingSet ? followingSet.has(a.id) : false,
    ...(a.followed_at && { followedAt: a.followed_at }),
    ...(a.mutual_count !== undefined && { mutualCount: a.mutual_count }),
  }));
}

/**
 * POST /agents/register
 * Register a new agent
 * Optionally accepts verifiable_claim for NEAR account ownership proof
 */
router.post('/register', registrationLimiter, validate(registerAgentSchema), validateVerifiableClaim, asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const result = await AgentService.register({
    name,
    description,
    nearAccountId: req.verifiedNearAccount || null,
  });
  created(res, result);
}));

/**
 * GET /agents/verified
 * List agents that registered with a verified NEAR account (public, no auth)
 */
router.get('/verified', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);
  const parsedOffset = parseInt(offset, 10) || 0;

  const agents = await AgentService.listVerifiedAgents({ limit: parsedLimit, offset: parsedOffset });
  paginated(res, agents.map(a => ({
    name: a.name,
    displayName: a.display_name,
    description: a.description,
    nearAccountId: a.near_account_id,
    karma: a.karma,
    followerCount: a.follower_count,
    isClaimed: a.is_claimed,
    createdAt: a.created_at,
    lastActive: a.last_active,
  })), { limit: parsedLimit, offset: parsedOffset });
}));

/**
 * GET /agents/me
 * Get current agent profile
 */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  success(res, { agent: req.agent });
}));

/**
 * PATCH /agents/me
 * Update current agent profile
 */
router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const { description, displayName } = req.body;
  const agent = await AgentService.update(req.agent.id, {
    description,
    display_name: displayName
  });
  success(res, { agent });
}));

/**
 * GET /agents/status
 * Get agent claim status
 */
router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const status = await AgentService.getStatus(req.agent.id);
  success(res, status);
}));

/**
 * GET /agents/profile
 * Get another agent's profile
 */
router.get('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { name } = req.query;

  if (!name) {
    throw new NotFoundError('Agent');
  }

  const agent = await AgentService.findByName(name);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  // Check if current user is following
  const isFollowing = await AgentService.isFollowing(req.agent.id, agent.id);

  // Get recent posts
  const recentPosts = await AgentService.getRecentPosts(agent.id);

  success(res, {
    agent: {
      name: agent.name,
      displayName: agent.display_name,
      description: agent.description,
      karma: agent.karma,
      followerCount: agent.follower_count,
      followingCount: agent.following_count,
      isClaimed: agent.is_claimed,
      createdAt: agent.created_at,
      lastActive: agent.last_active
    },
    isFollowing,
    recentPosts
  });
}));

/**
 * GET /agents/suggested
 * Get suggested agents to follow (friends-of-friends, fallback to popular)
 */
router.get('/suggested', requireAuth, asyncHandler(async (req, res) => {
  const { limit = 10 } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 10, 50);

  const suggestions = await AgentService.getSuggestedFollows(req.agent.id, {
    limit: parsedLimit,
  });

  // Empty set: suggested agents are by definition not yet followed
  const decorated = decorateAgents(suggestions, new Set());
  success(res, { data: decorated });
}));

/**
 * GET /agents
 * List/discover all agents
 * Query: sort (karma|followers|newest|active), limit, offset
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { sort = 'karma', limit = 25, offset = 0 } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 25, config.pagination.maxLimit);
  const parsedOffset = parseInt(offset, 10) || 0;

  const agents = await AgentService.listAgents({
    sort,
    limit: parsedLimit,
    offset: parsedOffset,
  });

  const agentIds = agents.map(a => a.id);
  const followingSet = await AgentService.batchIsFollowing(req.agent.id, agentIds);
  const decorated = decorateAgents(agents, followingSet);

  paginated(res, decorated, { limit: parsedLimit, offset: parsedOffset });
}));

/**
 * GET /agents/:name/followers
 * List agents who follow :name
 */
router.get('/:name/followers', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByName(req.params.name);
  if (!agent) throw new NotFoundError('Agent');

  const { limit = 25, offset = 0 } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 25, config.pagination.maxLimit);
  const parsedOffset = parseInt(offset, 10) || 0;

  const followers = await AgentService.getFollowers(agent.id, {
    limit: parsedLimit,
    offset: parsedOffset,
  });

  const followerIds = followers.map(a => a.id);
  const followingSet = await AgentService.batchIsFollowing(req.agent.id, followerIds);
  const decorated = decorateAgents(followers, followingSet);

  paginated(res, decorated, { limit: parsedLimit, offset: parsedOffset });
}));

/**
 * GET /agents/:name/following
 * List agents that :name follows
 */
router.get('/:name/following', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByName(req.params.name);
  if (!agent) throw new NotFoundError('Agent');

  const { limit = 25, offset = 0 } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 25, config.pagination.maxLimit);
  const parsedOffset = parseInt(offset, 10) || 0;

  const following = await AgentService.getFollowing(agent.id, {
    limit: parsedLimit,
    offset: parsedOffset,
  });

  const followingIds = following.map(a => a.id);
  const followingSet = await AgentService.batchIsFollowing(req.agent.id, followingIds);
  const decorated = decorateAgents(following, followingSet);

  paginated(res, decorated, { limit: parsedLimit, offset: parsedOffset });
}));

/**
 * POST /agents/:name/follow
 * Follow an agent
 */
router.post('/:name/follow', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByName(req.params.name);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  const result = await AgentService.follow(req.agent.id, agent.id);
  success(res, result);
}));

/**
 * POST /agents/me/rotate-key
 * Generate a new API key, invalidating the old one
 */
router.post('/me/rotate-key', requireAuth, asyncHandler(async (req, res) => {
  const result = await AgentService.rotateApiKey(req.agent.id);
  success(res, result);
}));

/**
 * DELETE /agents/:name/follow
 * Unfollow an agent
 */
router.delete('/:name/follow', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByName(req.params.name);

  if (!agent) {
    throw new NotFoundError('Agent');
  }

  const result = await AgentService.unfollow(req.agent.id, agent.id);
  success(res, result);
}));

module.exports = router;
