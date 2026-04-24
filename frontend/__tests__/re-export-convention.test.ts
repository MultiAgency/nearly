/**
 * @jest-environment node
 *
 * Convention pin: frontend tests must not exercise symbols that are pure
 * re-exports from @nearly/sdk. Those symbols' behavior is owned by the SDK
 * and tested in packages/sdk/__tests__/. Frontend tests should cover only
 * wrapper-local behavior + a single "delegates to SDK" sanity pin per
 * wrapper — see fastdata-utils.test.ts for the pattern.
 *
 * Without this mechanical enforcement, duplication accumulates as more
 * SDK functions get re-exported (the profileCompleteness/profileGaps block
 * had 11 such duplicate tests before 2026-04 cleanup). A simple grep at
 * CI time keeps the convention from drifting.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Extract names from every `export { a, b, c } from '@nearly/sdk'` in a file. */
function extractReExportsFromSdk(source: string): string[] {
  const pattern = /export\s*\{([^}]+)\}\s*from\s*['"]@nearly\/sdk['"]/g;
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Walk frontend/src/ and collect every pure SDK re-export. */
function collectReExports(srcDir: string): Map<string, string[]> {
  const byModule = new Map<string, string[]>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry)) {
        const names = extractReExportsFromSdk(readFileSync(p, 'utf8'));
        if (names.length > 0) byModule.set(p, names);
      }
    }
  }
  walk(srcDir);
  return byModule;
}

/** All .test.ts(x) files under frontend/__tests__/, excluding this one. */
function collectTestFiles(dir: string, selfPath: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...collectTestFiles(p, selfPath));
    else if (/\.test\.tsx?$/.test(entry) && p !== selfPath) out.push(p);
  }
  return out;
}

describe('architectural convention: no frontend tests for SDK re-exports', () => {
  // Discovery runs once; violation scan per test file.
  const srcDir = join(__dirname, '..', 'src');
  const reExports = collectReExports(srcDir);
  const testFiles = collectTestFiles(__dirname, __filename);

  it('at least one re-export exists (sanity — otherwise the convention is trivially met)', () => {
    // If this fires, every re-export has been inlined or moved to SDK import.
    // That's fine; delete this test with the last re-export.
    const total = [...reExports.values()].flat();
    expect(total.length).toBeGreaterThan(0);
  });

  it('no frontend test imports a pure SDK re-export from its re-exporting module', () => {
    // Build the alias paths the test-side imports would use, keyed by
    // expected name set.
    const expectationsByAlias = new Map<string, Set<string>>();
    for (const [modulePath, names] of reExports) {
      const relFromSrc = modulePath
        .slice(srcDir.length + 1)
        .replace(/\.tsx?$/, '');
      expectationsByAlias.set(`@/${relFromSrc}`, new Set(names));
    }

    // Generic import parser — matches `import { a, b } from '...'` anywhere.
    const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    const violations: string[] = [];
    for (const testFile of testFiles) {
      const src = readFileSync(testFile, 'utf8');
      for (const match of src.matchAll(importRe)) {
        const names = match[1]
          .split(',')
          .map((n) =>
            n
              .trim()
              .split(/\s+as\s+/)[0]
              .trim(),
          )
          .filter(Boolean);
        const forbidden = expectationsByAlias.get(match[2]);
        if (!forbidden) continue;
        for (const name of names) {
          if (forbidden.has(name)) {
            violations.push(
              `${testFile.replace(`${__dirname}/`, '__tests__/')} imports re-exported symbol "${name}" from "${match[2]}" — test the SDK function in packages/sdk/__tests__/ instead`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
