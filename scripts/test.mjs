#!/usr/bin/env node
//
// Test runner for ProManage NZ.
//
//   node scripts/test.mjs                 # all suites
//   node scripts/test.mjs dates money     # only suites whose name matches
//
// Requires playwright. CI installs it; locally:
//   npm install --no-save playwright && npx playwright install chromium
//
// WHY A BROWSER RUNNER RATHER THAN NODE.
//
// The app is deliberately a single file with no build step and no module
// system — CLAUDE.md is explicit that this is not to be "simplified". That
// leaves three ways to test its logic: extract the functions into a module
// (a refactor the project does not want), re-implement them in the test
// (which tests the copy, not the app), or load the real page and call the
// real functions. This does the third.
//
// It works because of how classic scripts scope their declarations: top-level
// `function` declarations become properties of window, and top-level `const`
// and `let` land in the global lexical environment. Both are reachable as bare
// identifiers inside page.evaluate(), so a suite can call escapeHtml() or read
// GST_RATE with no changes whatsoever to index.html.
//
// The page is booted ONCE and shared by every suite, so tests must not depend
// on mutable app state or on each other. Assert on pure functions and on values
// derived from arguments you pass in.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openApp, ROOT } from './lib/harness.mjs';

const filters = process.argv.slice(2);

class AssertionError extends Error {}

const fmt = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

const assertions = {
  eq(actual, expected, msg) {
    if (!Object.is(actual, expected)) {
      throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(expected)}, got ${fmt(actual)}`);
    }
  },
  deepEq(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
  },
  ok(value, msg) {
    if (!value) throw new AssertionError(msg || `expected truthy, got ${fmt(value)}`);
  },
  notOk(value, msg) {
    if (value) throw new AssertionError(msg || `expected falsy, got ${fmt(value)}`);
  }
};

const suiteDir = join(ROOT, 'scripts', 'tests');
const files = (await readdir(suiteDir)).filter((f) => f.endsWith('.test.mjs')).sort();

if (!files.length) {
  console.error(`No test suites found in ${suiteDir}`);
  process.exit(1);
}

console.log('Booting the app…\n');
const { page, pageErrors, close } = await openApp();

// A page that threw on the way up makes every result below meaningless —
// functions would still be hoisted and callable while the state they depend on
// was never built. Stop rather than report a suite of misleading passes.
if (pageErrors.length) {
  console.error('The app threw while booting; refusing to run tests against a half-built page:\n');
  for (const e of pageErrors) console.error('  ' + e);
  await close();
  process.exit(1);
}

// Evaluate a function in the page, where the app's own declarations are in
// scope. Takes one optional argument, exactly like page.evaluate — pass an
// object or array when a case needs several. The argument must be
// JSON-serialisable: the function is serialised and re-parsed in the browser,
// so it closes over nothing from this file.
const app = (fn, arg) => page.evaluate(fn, arg);

let passed = 0, failed = 0, skipped = 0;
const failures = [];

for (const file of files) {
  const mod = await import(pathToFileURL(join(suiteDir, file)).href);
  const suiteName = mod.name || file.replace(/\.test\.mjs$/, '');

  if (filters.length && !filters.some((f) => suiteName.includes(f) || file.includes(f))) {
    skipped++;
    continue;
  }

  console.log(suiteName);

  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });
  mod.default({ test, app, ...assertions });

  for (const { name, fn } of cases) {
    const started = Date.now();
    try {
      await fn();
      const ms = Date.now() - started;
      console.log(`  ok    ${name}${ms > 200 ? ` (${ms}ms)` : ''}`);
      passed++;
    } catch (err) {
      console.log(`  FAIL  ${name}`);
      failed++;
      failures.push({
        suite: suiteName,
        name,
        message: err instanceof AssertionError ? err.message : (err.stack || String(err))
      });
    }
  }
  console.log('');
}

await close();

if (failures.length) {
  console.error(`FAILED — ${failed} of ${passed + failed}:\n`);
  for (const f of failures) console.error(`  ✗ ${f.suite} › ${f.name}\n    ${f.message}\n`);
  process.exit(1);
}

console.log(
  `${passed} passed` +
  (skipped ? `, ${skipped} suite${skipped === 1 ? '' : 's'} filtered out` : '') +
  '.'
);
