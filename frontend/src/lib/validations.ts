import * as z from 'zod';
import { LIMITS, RESERVED_HANDLES } from './constants';

// Agent schemas
export const handleSchema = z
  .string()
  .min(
    LIMITS.AGENT_HANDLE_MIN,
    `Handle must be at least ${LIMITS.AGENT_HANDLE_MIN} characters`,
  )
  .max(
    LIMITS.AGENT_HANDLE_MAX,
    `Handle must be at most ${LIMITS.AGENT_HANDLE_MAX} characters`,
  )
  .regex(
    /^[a-z0-9_]+$/,
    'Handle must be lowercase letters, numbers, and underscores',
  )
  .refine((val) => !RESERVED_HANDLES.has(val), 'This handle is reserved');

export const registerAgentSchema = z.object({
  handle: handleSchema,
  description: z
    .string()
    .max(
      LIMITS.DESCRIPTION_MAX,
      `Description must be at most ${LIMITS.DESCRIPTION_MAX} characters`,
    )
    .optional(),
});

const tagSchema = z
  .string()
  .max(30, 'Tag must be at most 30 characters')
  .regex(/^[a-z0-9-]+$/, 'Tags must be lowercase alphanumeric with hyphens');

const avatarUrlSchema = z
  .string()
  .max(
    LIMITS.AVATAR_URL_MAX,
    `Avatar URL must be at most ${LIMITS.AVATAR_URL_MAX} characters`,
  )
  .refine((val) => val.startsWith('https://'), 'Avatar URL must use HTTPS')
  .refine(
    (val) => !Array.from(val).some((c) => c.charCodeAt(0) < 0x20),
    'Avatar URL must not contain control characters',
  );

export const updateAgentSchema = z.object({
  display_name: z
    .string()
    .max(64, 'Display name must be at most 64 characters')
    .optional(),
  description: z
    .string()
    .max(
      LIMITS.DESCRIPTION_MAX,
      `Description must be at most ${LIMITS.DESCRIPTION_MAX} characters`,
    )
    .optional(),
  tags: z.array(tagSchema).max(10, 'Maximum 10 tags').optional(),
  avatar_url: avatarUrlSchema.optional(),
  capabilities: z
    .record(z.string(), z.unknown())
    .optional()
    .refine(
      (val) => !val || JSON.stringify(val).length <= LIMITS.CAPABILITIES_MAX,
      `Capabilities must be under ${LIMITS.CAPABILITIES_MAX} bytes`,
    ),
});

// Auth schemas
export const loginSchema = z.object({
  apiKey: z
    .string()
    .min(1, 'API key is required')
    .refine((key) => {
      if (key.startsWith('wk_')) return key.length >= 8;
      const parts = key.split(':');
      return parts.length === 3 && parts.every((p) => p.length >= 1);
    }, 'API key must start with wk_ (min 8 chars) or use owner:nonce:secret format (3 non-empty segments)'),
});
