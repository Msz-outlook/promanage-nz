#!/usr/bin/env node
//
// Boot smoke test. Serves the repo on localhost and loads the app in a real
// browser, because the failure this guards against is invisible to a syntax
// check: the markup renders, function declarations hoist, every onclick
// handler exists and is callable — and nothing behind them is wired up.
//
//   node scripts/smoke-test.mjs
//
// Requires playwright. CI installs it on the fly; locally:
//   npm install --no-save playwright && npx playwright install chromium
//
// The assertions below deliberately check *side effects of top-level
// statements*, not the presence of functions. Declarations are hoisted, so
// `typeof saveInspection === 'function'` stays true even when the block that
// defines it threw on line one. Only a side effect proves the block ran.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};

// Service workers need a secure context; localhost counts as one.
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failures.push({ name, detail }); }
};

// CHROMIUM_PATH lets an environment with a pre-installed browser point at it
// rather than downloading a second copy. CI leaves it unset and uses the one
// `npx playwright install chromium` puts in the default location.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const context = await browser.newContext();
const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('console', (msg) => {
  // The browser requests /favicon.ico on its own and the repo has no such
  // file — a permanent, meaningless 404 that would otherwise sit in every
  // failure report.
  if (msg.type() === 'error' && !msg.location()?.url?.endsWith('/favicon.ico')) {
    consoleErrors.push(msg.text());
  }
});

// The app is offline-first and CI has no Supabase credentials, so let network
// calls to Supabase fail naturally — a boot that depends on them reaching the
// server is itself a bug worth catching.
await page.goto(origin, { waitUntil: 'load' });
await page.waitForTimeout(2500); // let DOMContentLoaded work and SW registration settle

/* No uncaught exceptions anywhere during boot. */
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n    '));

/* The login gate is what an unauthenticated visitor must see. */
check('login gate is visible', await page.locator('#login-gate').isVisible());
check('sign-in button is present', await page.locator('#login-btn').count() === 1);

/* Every vendored library loaded. Each is an independent <script src> that can
   fail on its own, and a missing one has taken the whole app down before. */
for (const [name, expr] of [
  ['supabase-js', 'typeof supabase === "object" && typeof supabase.createClient === "function"'],
  ['jsPDF', '!!(window.jspdf && window.jspdf.jsPDF)'],
  ['heic2any', 'typeof heic2any === "function"']
]) {
  check(`vendored ${name} loaded`, await page.evaluate(expr));
}

/* The three PDF modules each end their IIFE by assigning to global — proof
   that script block 0 ran to completion, not merely that it was parsed. */
for (const name of ['FindingsReport', 'InvoiceReport', 'StatementReport']) {
  check(`${name} registered`, await page.evaluate(`typeof window.${name} === "object"`));
}

/* The exact regression from the CLAUDE.md incident: a vendored library 404s,
   `const sb = supabase.createClient(...)` throws, and every top-level statement
   after it is abandoned while the page still looks completely normal.

   `sb` and `backendInitError` are top-level `let`, which — unlike `var` — does
   NOT become a property of window. They have to be read as bare identifiers,
   and reading one that never initialised throws a ReferenceError from the
   temporal dead zone (`typeof` does not protect against TDZ), so each read is
   wrapped in the page. A throw here is itself the failure signal. */
const safeEval = async (expr) => {
  const r = await page.evaluate(`(() => { try { return { v: (${expr}) }; }
                                          catch (e) { return { e: String(e) }; } })()`);
  return r.e ? { ok: false, detail: r.e } : { ok: !!r.v, detail: '' };
};

{
  const r = await safeEval('typeof sb !== "undefined" && sb !== null');
  check('supabase client constructed', r.ok, r.detail);
}
{
  const r = await safeEval('typeof backendInitError !== "undefined" && backendInitError === null');
  check('no backend init error', r.ok, r.detail || (await safeEval('String(backendInitError)')).detail);
}

/* Service-worker registration is the last top-level statement in block 1.
   If it happened, the entire block ran — this is the strongest single
   assertion that nothing threw partway down. */
check(
  'service worker registered (block 1 ran to completion)',
  (await page.evaluate('navigator.serviceWorker.getRegistrations().then(r => r.length)')) > 0
);

await browser.close();
server.close();

console.log('');
if (failures.length) {
  console.error(`FAILED — ${failures.length} check${failures.length === 1 ? '' : 's'}:\n`);
  for (const { name, detail } of failures) console.error(`  ✗ ${name}${detail ? '\n    ' + detail : ''}\n`);
  if (consoleErrors.length) console.error('  console errors during boot:\n    ' + consoleErrors.join('\n    ') + '\n');
  process.exit(1);
}
console.log('Smoke test passed.');
