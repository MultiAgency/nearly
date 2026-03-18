/**
 * Integration Tests: POST /api/v1/agents/register with NEP-413 claims
 *
 * Runs the full Express app with in-memory database (no PostgreSQL needed).
 * Run: node test/register-nep413.test.js
 */

const http = require('http');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const { describe, test, assert, assertEqual, runTests } = require('./helpers');

// --- Crypto helpers (from verifiable-claim.test.js) ---

function writeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function base58Encode(buffer) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + buffer.toString('hex'));
  let str = '';
  while (num > 0n) {
    str = ALPHABET[Number(num % 58n)] + str;
    num = num / 58n;
  }
  for (const byte of buffer) {
    if (byte === 0) str = '1' + str;
    else break;
  }
  return str || '1';
}

function createTestClaim(overrides = {}) {
  const keypair = nacl.sign.keyPair();

  const message = overrides.message || JSON.stringify({
    action: 'register',
    domain: 'market.near.ai',
    version: 1,
    timestamp: overrides.timestamp || Date.now(),
  });

  const recipient = 'market.near.ai';
  const nonce = overrides.nonce || crypto.randomBytes(32);
  const nonceBase64 = Buffer.from(nonce).toString('base64');

  const NEP413_TAG = 2147484061;
  const messageBytes = Buffer.from(message, 'utf-8');
  const recipientBytes = Buffer.from(recipient, 'utf-8');

  const payload = Buffer.concat([
    writeU32LE(NEP413_TAG),
    writeU32LE(messageBytes.length),
    messageBytes,
    Buffer.from(nonce),
    writeU32LE(recipientBytes.length),
    recipientBytes,
    Buffer.from([0]),
  ]);

  const hash = crypto.createHash('sha256').update(payload).digest();
  const signature = nacl.sign.detached(hash, keypair.secretKey);

  const publicKeyBase58 = 'ed25519:' + base58Encode(Buffer.from(keypair.publicKey));
  const signatureBase58 = 'ed25519:' + base58Encode(Buffer.from(signature));

  return {
    claim: {
      near_account_id: overrides.near_account_id || 'test-account.near',
      public_key: overrides.public_key || publicKeyBase58,
      signature: overrides.signature || signatureBase58,
      nonce: nonceBase64,
      message,
    },
    keypair,
  };
}

// --- HTTP helper ---

let baseUrl;
let testIndex = 0;

async function post(path, body) {
  testIndex++;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.0.0.${testIndex}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const data = await res.json();
  return { status: res.status, data };
}

// --- Stub NEAR RPC ---

const originalFetch = global.fetch;

function stubNearRpc() {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && (url.includes('rpc') || url.includes('fastnear'))) {
      return {
        json: async () => ({ error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } }),
      };
    }
    return realFetch(url, opts);
  };
}

// --- Tests ---

describe('Registration without verifiable_claim', () => {
  test('registers an agent with name and description', async () => {
    const { status, data } = await post('/api/v1/agents/register', {
      name: 'baseline_agent',
      description: 'A test agent',
    });

    assertEqual(status, 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    assert(data.success === true, 'Expected success: true');
    assert(data.agent.api_key.startsWith('moltbook_'), 'API key should start with moltbook_');
    assert(data.agent.id, 'Should have agent id');
    assertEqual(data.agent.near_account_id, undefined, 'Should not have near_account_id');
  });
});

describe('Registration with valid NEP-413 claim', () => {
  test('registers agent with verified NEAR account', async () => {
    const { claim } = createTestClaim({ near_account_id: 'alice.near' });
    const { status, data } = await post('/api/v1/agents/register', {
      name: 'alice_agent',
      description: 'Alice verified agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    assert(data.success === true, 'Expected success: true');
    assertEqual(data.agent.near_account_id, 'alice.near');
    assert(data.agent.api_key.startsWith('moltbook_'), 'API key should start with moltbook_');
  });
});

describe('Registration with invalid signature', () => {
  test('rejects tampered message', async () => {
    const { claim } = createTestClaim({ near_account_id: 'tampered.near' });
    claim.message = claim.message.replace('"register"', '"login"');

    const { status, data } = await post('/api/v1/agents/register', {
      name: 'tampered_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'INVALID_MESSAGE_FORMAT');
  });
});

describe('Registration with expired timestamp', () => {
  test('rejects stale timestamp (31 min ago)', async () => {
    const { claim } = createTestClaim({
      near_account_id: 'expired.near',
      timestamp: Date.now() - 31 * 60 * 1000,
    });

    const { status, data } = await post('/api/v1/agents/register', {
      name: 'expired_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'TIMESTAMP_EXPIRED');
  });
});

describe('Registration with future timestamp', () => {
  test('rejects timestamp 5 minutes in the future', async () => {
    const { claim } = createTestClaim({
      near_account_id: 'future.near',
      timestamp: Date.now() + 5 * 60 * 1000,
    });

    const { status, data } = await post('/api/v1/agents/register', {
      name: 'future_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'TIMESTAMP_EXPIRED');
  });
});

describe('Duplicate NEAR account', () => {
  test('rejects second registration with same NEAR account', async () => {
    const { claim: claim1 } = createTestClaim({ near_account_id: 'bob.near' });
    const { status: s1 } = await post('/api/v1/agents/register', {
      name: 'bob_agent_1',
      verifiable_claim: claim1,
    });
    assertEqual(s1, 201, 'First registration should succeed');

    const { claim: claim2 } = createTestClaim({ near_account_id: 'bob.near' });
    const { status: s2, data: d2 } = await post('/api/v1/agents/register', {
      name: 'bob_agent_2',
      verifiable_claim: claim2,
    });

    assertEqual(s2, 409, `Expected 409, got ${s2}: ${JSON.stringify(d2)}`);
    assertEqual(d2.code, 'CONFLICT');
  });
});

describe('Nonce replay', () => {
  test('rejects reused nonce', async () => {
    const sharedNonce = crypto.randomBytes(32);

    const { claim: claim1 } = createTestClaim({
      near_account_id: 'nonce1.near',
      nonce: sharedNonce,
    });
    const { status: s1 } = await post('/api/v1/agents/register', {
      name: 'nonce_agent_1',
      verifiable_claim: claim1,
    });
    assertEqual(s1, 201, 'First use of nonce should succeed');

    const { claim: claim2 } = createTestClaim({
      near_account_id: 'nonce2.near',
      nonce: sharedNonce,
    });
    const { status: s2, data: d2 } = await post('/api/v1/agents/register', {
      name: 'nonce_agent_2',
      verifiable_claim: claim2,
    });

    assertEqual(s2, 400, `Expected 400, got ${s2}`);
    assertEqual(d2.code, 'NONCE_REPLAY');
  });
});

describe('Missing required claim fields', () => {
  test('rejects claim without public_key', async () => {
    const { claim } = createTestClaim({ near_account_id: 'missing.near' });
    delete claim.public_key;

    const { status, data } = await post('/api/v1/agents/register', {
      name: 'missing_field_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
  });
});

describe('Validation errors', () => {
  test('rejects missing name', async () => {
    const { status, data } = await post('/api/v1/agents/register', {
      description: 'No name provided',
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'VALIDATION_ERROR');
  });

  test('rejects name too short', async () => {
    const { status, data } = await post('/api/v1/agents/register', {
      name: 'a',
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'VALIDATION_ERROR');
  });
});

describe('Verified agents endpoint', () => {
  test('lists agents registered with NEAR accounts', async () => {
    const { status, data } = await get('/api/v1/agents/verified');

    assertEqual(status, 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.data), 'Should return an array');
    // alice.near and bob.near were registered earlier
    const nearIds = data.data.map(a => a.nearAccountId);
    assert(nearIds.includes('alice.near'), 'Should include alice.near');
    assert(nearIds.includes('bob.near'), 'Should include bob.near');
  });
});

// --- Runner ---
let server;

runTests('NEP-413 Registration Integration Tests', {
  async before() {
    const app = require('../src/app');
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    stubNearRpc();
  },
  async after() {
    global.fetch = originalFetch;
    server.close();
  },
});
