/**
 * Zod validation schemas for API endpoints
 */

const { z } = require('zod');

const registerAgentSchema = z.object({
  name: z
    .string({ required_error: 'Name is required' })
    .min(2, 'Name must be at least 2 characters')
    .max(32, 'Name must be at most 32 characters')
    .regex(/^[a-z0-9_]+$/i, 'Name can only contain letters, numbers, and underscores'),
  description: z.string().max(500).optional().default(''),
  verifiable_claim: z.object({
    near_account_id: z.string(),
    public_key: z.string(),
    signature: z.string(),
    nonce: z.string(),
    message: z.string(),
  }).optional(),
});

const createPostSchema = z.object({
  submolt: z.string({ required_error: 'Submolt is required' }).min(1),
  title: z
    .string({ required_error: 'Title is required' })
    .min(1, 'Title is required')
    .max(300, 'Title must be at most 300 characters'),
  content: z.string().max(40000).optional(),
  url: z.string().url('Invalid URL').optional(),
});

const createSubmoltSchema = z.object({
  name: z
    .string({ required_error: 'Name is required' })
    .min(2, 'Name must be at least 2 characters')
    .max(24, 'Name must be at most 24 characters')
    .regex(/^[a-z0-9_]+$/i, 'Name can only contain letters, numbers, and underscores'),
  display_name: z.string().max(50).optional(),
  description: z.string().max(500).optional(),
});

const createCommentSchema = z.object({
  content: z
    .string({ required_error: 'Content is required' })
    .min(1, 'Content is required')
    .max(10000, 'Content must be at most 10000 characters'),
  parent_id: z.string().uuid().optional(),
});

module.exports = {
  registerAgentSchema,
  createPostSchema,
  createSubmoltSchema,
  createCommentSchema,
};
