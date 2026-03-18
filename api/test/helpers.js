/**
 * Minimal test framework shared across all test suites.
 */

let passed = 0;
let failed = 0;
const tests = [];

function describe(name, fn) {
  tests.push({ type: 'describe', name });
  fn();
}

function test(name, fn) {
  tests.push({ type: 'test', name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function assertThrows(fn, check, label) {
  try {
    await fn();
    throw new Error(`${label || 'Function'} should have thrown`);
  } catch (err) {
    if (err.message.includes('should have thrown')) throw err;
    if (typeof check === 'number' && err.statusCode !== check)
      throw new Error(`${label}: expected status ${check}, got ${err.statusCode}`);
    if (typeof check === 'string' && err.code !== check)
      throw new Error(`${label}: expected code ${check}, got ${err.code}`);
  }
}

async function runTests(suiteName, { before, after } = {}) {
  if (before) await before();

  console.log(`\n${suiteName}\n`);
  console.log('='.repeat(50));

  for (const item of tests) {
    if (item.type === 'describe') {
      console.log(`\n[${item.name}]\n`);
    } else {
      try {
        await item.fn();
        console.log(`  + ${item.name}`);
        passed++;
      } catch (error) {
        console.log(`  - ${item.name}`);
        console.log(`    Error: ${error.message}`);
        failed++;
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  if (after) await after();

  process.exit(failed > 0 ? 1 : 0);
}

module.exports = { describe, test, assert, assertEqual, assertThrows, runTests };
