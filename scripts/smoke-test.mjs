#!/usr/bin/env node
//
// Boot smoke test. Loads the app in a real browser, because the failure this
// guards against is invisible to a syntax check: the markup renders, function
// declarations hoist, every onclick handler exists and is callable — and
// nothing behind them is wired up.
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
//
// This is the "does it boot" check. Logic lives in scripts/test.mjs.

import { openApp } from './lib/harness.mjs';

const failures = [];
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}`); failures.push({ name, detail }); }
};

// The app is offline-first and CI has no Supabase credentials, so let network
// calls to Supabase fail naturally — a boot that depends on them reaching the
// server is itself a bug worth catching.
const { page, pageErrors, consoleErrors, close } = await openApp();

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

await close();

console.log('');
if (failures.length) {
  console.error(`FAILED — ${failures.length} check${failures.length === 1 ? '' : 's'}:\n`);
  for (const { name, detail } of failures) console.error(`  ✗ ${name}${detail ? '\n    ' + detail : ''}\n`);
  if (consoleErrors.length) console.error('  console errors during boot:\n    ' + consoleErrors.join('\n    ') + '\n');
  process.exit(1);
}
console.log('Smoke test passed.');
