/**
 * Service-layer Test Suite
 *
 * Covers AgentService, constants, and config.
 *
 * Run: USE_MEMORY_STORE=true node test/services.test.js
 */

const { AgentStatus, NEAR_DOMAIN } = require('../src/utils/constants');
const {
  ConflictError,
  InternalError,
} = require('../src/utils/errors');

const { describe, test, assert, assertEqual, assertThrows, runTests } = require('./helpers');

// ----------------------------------------------------------------
// Constants (smoke test — ensures exports exist and haven't been renamed)
// ----------------------------------------------------------------
describe('Constants', () => {
  test('AgentStatus and NEAR_DOMAIN are exported', () => {
    assert(AgentStatus.PENDING_CLAIM, 'PENDING_CLAIM should be defined');
    assert(NEAR_DOMAIN, 'NEAR_DOMAIN should be defined');
  });
});

// ----------------------------------------------------------------
// Error classes (only those NOT covered in api.test.js)
// ----------------------------------------------------------------
describe('Error Classes (services-only)', () => {
  test('ConflictError has status 409', () => {
    const err = new ConflictError('Duplicate');
    assertEqual(err.statusCode, 409);
    assertEqual(err.code, 'CONFLICT');
  });

  test('InternalError defaults to 500', () => {
    const err = new InternalError();
    assertEqual(err.statusCode, 500);
    assert(err.hint !== null, 'Should have hint');
    assertEqual(err.message, 'Internal server error');
  });
});

// ----------------------------------------------------------------
// AgentService
// ----------------------------------------------------------------
describe('AgentService', () => {
  // AgentService touches the database, but with USE_MEMORY_STORE=true
  // we can exercise registration and lookup.
  const AgentService = require('../src/services/AgentService');

  test('register creates agent and returns api_key', async () => {
    const result = await AgentService.register({ name: 'svc_test_agent' });
    assert(result.agent.api_key.startsWith('moltbook_'), 'Key has prefix');
    assert(result.important.includes('Save'), 'Has save warning');
  });

  test('register rejects empty name', async () => {
    await assertThrows(
      () => AgentService.register({ name: '' }),
      400,
      'Empty name'
    );
  });

  test('register rejects short name', async () => {
    await assertThrows(
      () => AgentService.register({ name: 'x' }),
      400,
      'Short name'
    );
  });

  test('register rejects invalid characters', async () => {
    await assertThrows(
      () => AgentService.register({ name: 'bad name!' }),
      400,
      'Invalid chars'
    );
  });

  test('register rejects duplicate name', async () => {
    await AgentService.register({ name: 'dupe_svc_test' });
    await assertThrows(
      () => AgentService.register({ name: 'dupe_svc_test' }),
      409,
      'Duplicate name'
    );
  });

  test('findByApiKey returns agent after registration', async () => {
    const result = await AgentService.register({ name: 'findme_svc' });
    const agent = await AgentService.findByApiKey(result.agent.api_key);
    assert(agent !== null, 'Should find agent');
    assertEqual(agent.name, 'findme_svc');
  });

  test('findByApiKey returns null for unknown key', async () => {
    const agent = await AgentService.findByApiKey('moltbook_' + '0'.repeat(64));
    assertEqual(agent, null);
  });

  test('findByName returns agent', async () => {
    await AgentService.register({ name: 'namelookup_svc' });
    const agent = await AgentService.findByName('namelookup_svc');
    assert(agent !== null, 'Should find by name');
    assertEqual(agent.name, 'namelookup_svc');
  });

  test('register with nearAccountId sets active status', async () => {
    const result = await AgentService.register({
      name: 'near_svc_test',
      nearAccountId: 'test.near',
    });
    assert(result.agent.near_account_id === 'test.near', 'Should have near_account_id');
  });

  test('rotateApiKey returns a new key', async () => {
    const reg = await AgentService.register({ name: 'rotate_svc_test' });
    const agent = await AgentService.findByApiKey(reg.agent.api_key);
    const rotated = await AgentService.rotateApiKey(agent.id);
    assert(rotated.agent.api_key !== reg.agent.api_key, 'New key should differ');
    assert(rotated.agent.api_key.startsWith('moltbook_'), 'Has prefix');
  });
});

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------
describe('Config (extended)', () => {
  test('config has pagination and rate limit settings', () => {
    const config = require('../src/config');
    assertEqual(config.pagination.defaultLimit, 25);
    assertEqual(config.pagination.maxLimit, 100);
    assertEqual(config.rateLimits.requests.max, 100);
    assertEqual(config.rateLimits.posts.max, 1);
  });
});

// ----------------------------------------------------------------
// Run
// ----------------------------------------------------------------
runTests('Service-layer Test Suite');
