import {
  agentNameSchema,
  registerAgentSchema,
  updateAgentSchema,
  createPostSchema,
  createCommentSchema,
  submoltNameSchema,
  createSubmoltSchema,
  loginSchema,
  searchSchema,
} from '@/lib/validations';

describe('Validation Schemas', () => {
  describe('agentNameSchema', () => {
    it('accepts valid names', () => {
      expect(agentNameSchema.safeParse('agent_1').success).toBe(true);
      expect(agentNameSchema.safeParse('ab').success).toBe(true); // min boundary
      expect(agentNameSchema.safeParse('A'.repeat(32)).success).toBe(true); // max boundary
      expect(agentNameSchema.safeParse('Agent_Bot').success).toBe(true); // mixed case
    });

    it('rejects too short', () => {
      const result = agentNameSchema.safeParse('a');
      expect(result.success).toBe(false);
    });

    it('rejects too long', () => {
      const result = agentNameSchema.safeParse('a'.repeat(33));
      expect(result.success).toBe(false);
    });

    it('rejects invalid characters', () => {
      expect(agentNameSchema.safeParse('agent-name').success).toBe(false);
      expect(agentNameSchema.safeParse('agent name').success).toBe(false);
      expect(agentNameSchema.safeParse('agent@bot').success).toBe(false);
    });

    it('rejects empty string', () => {
      expect(agentNameSchema.safeParse('').success).toBe(false);
    });
  });

  describe('registerAgentSchema', () => {
    it('accepts valid registration', () => {
      const result = registerAgentSchema.safeParse({
        name: 'test_agent',
        description: 'A cool agent',
      });
      expect(result.success).toBe(true);
    });

    it('accepts registration without description', () => {
      const result = registerAgentSchema.safeParse({ name: 'test_agent' });
      expect(result.success).toBe(true);
    });

    it('rejects missing name', () => {
      const result = registerAgentSchema.safeParse({ description: 'hi' });
      expect(result.success).toBe(false);
    });

    it('rejects description over 500 chars', () => {
      const result = registerAgentSchema.safeParse({
        name: 'test',
        description: 'x'.repeat(501),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('updateAgentSchema', () => {
    it('accepts valid update', () => {
      expect(
        updateAgentSchema.safeParse({ displayName: 'Bot', description: 'hi' })
          .success,
      ).toBe(true);
    });

    it('accepts empty update', () => {
      expect(updateAgentSchema.safeParse({}).success).toBe(true);
    });

    it('rejects display name over 50 chars', () => {
      expect(
        updateAgentSchema.safeParse({ displayName: 'x'.repeat(51) }).success,
      ).toBe(false);
    });
  });

  describe('createPostSchema', () => {
    it('accepts valid text post', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: 'My Post',
        content: 'Hello world',
        postType: 'text',
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid link post', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: 'Check this',
        url: 'https://example.com',
        postType: 'link',
      });
      expect(result.success).toBe(true);
    });

    it('rejects text post without content', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: 'My Post',
        postType: 'text',
      });
      expect(result.success).toBe(false);
    });

    it('rejects link post without url', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: 'My Post',
        postType: 'link',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty title', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: '',
        content: 'hi',
        postType: 'text',
      });
      expect(result.success).toBe(false);
    });

    it('rejects title over 300 chars', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: 'x'.repeat(301),
        content: 'hi',
        postType: 'text',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty submolt', () => {
      const result = createPostSchema.safeParse({
        submolt: '',
        title: 'Test',
        content: 'hi',
        postType: 'text',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid URL', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: 'Test',
        url: 'not a url',
        postType: 'link',
      });
      expect(result.success).toBe(false);
    });

    it('accepts link post with empty string url field when text type', () => {
      const result = createPostSchema.safeParse({
        submolt: 'general',
        title: 'Test',
        content: 'body',
        url: '',
        postType: 'text',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('createCommentSchema', () => {
    it('accepts valid comment', () => {
      expect(
        createCommentSchema.safeParse({ content: 'Nice post!' }).success,
      ).toBe(true);
    });

    it('accepts comment with parentId', () => {
      expect(
        createCommentSchema.safeParse({
          content: 'Reply',
          parentId: 'comment-1',
        }).success,
      ).toBe(true);
    });

    it('rejects empty comment', () => {
      expect(
        createCommentSchema.safeParse({ content: '' }).success,
      ).toBe(false);
    });

    it('rejects comment over 10000 chars', () => {
      expect(
        createCommentSchema.safeParse({ content: 'x'.repeat(10001) }).success,
      ).toBe(false);
    });
  });

  describe('submoltNameSchema', () => {
    it('accepts valid names', () => {
      expect(submoltNameSchema.safeParse('general').success).toBe(true);
      expect(submoltNameSchema.safeParse('ab').success).toBe(true); // min
      expect(submoltNameSchema.safeParse('a'.repeat(24)).success).toBe(true); // max
    });

    it('rejects uppercase', () => {
      expect(submoltNameSchema.safeParse('General').success).toBe(false);
    });

    it('rejects too short', () => {
      expect(submoltNameSchema.safeParse('a').success).toBe(false);
    });

    it('rejects too long', () => {
      expect(submoltNameSchema.safeParse('a'.repeat(25)).success).toBe(false);
    });

    it('rejects special characters', () => {
      expect(submoltNameSchema.safeParse('my-community').success).toBe(false);
    });
  });

  describe('createSubmoltSchema', () => {
    it('accepts valid submolt', () => {
      expect(
        createSubmoltSchema.safeParse({ name: 'test_sub' }).success,
      ).toBe(true);
    });

    it('accepts with optional fields', () => {
      expect(
        createSubmoltSchema.safeParse({
          name: 'test_sub',
          displayName: 'Test Sub',
          description: 'A community',
        }).success,
      ).toBe(true);
    });
  });

  describe('loginSchema', () => {
    it('accepts valid API key', () => {
      expect(
        loginSchema.safeParse({ apiKey: 'moltbook_abc123' }).success,
      ).toBe(true);
    });

    it('rejects empty key', () => {
      expect(loginSchema.safeParse({ apiKey: '' }).success).toBe(false);
    });

    it('rejects wrong prefix', () => {
      expect(
        loginSchema.safeParse({ apiKey: 'invalid_abc123' }).success,
      ).toBe(false);
    });
  });

  describe('searchSchema', () => {
    it('accepts valid search', () => {
      expect(searchSchema.safeParse({ query: 'hello' }).success).toBe(true);
    });

    it('rejects single character query', () => {
      expect(searchSchema.safeParse({ query: 'a' }).success).toBe(false);
    });

    it('accepts optional limit', () => {
      expect(
        searchSchema.safeParse({ query: 'test', limit: 10 }).success,
      ).toBe(true);
    });

    it('rejects limit over max page size', () => {
      expect(
        searchSchema.safeParse({ query: 'test', limit: 101 }).success,
      ).toBe(false);
    });

    it('rejects limit of 0', () => {
      expect(
        searchSchema.safeParse({ query: 'test', limit: 0 }).success,
      ).toBe(false);
    });
  });
});
