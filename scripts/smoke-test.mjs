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

/* supabase-js is now the ONLY library that blocks the first paint, because
   auth runs at boot and nothing is on screen until it answers. It is an
   independent <script src> that can fail on its own, and a missing one has
   taken the whole app down before. */
check(
  'vendored supabase-js loaded',
  await page.evaluate('typeof supabase === "object" && typeof supabase.createClient === "function"')
);

/* Everything else is the INVERSE assertion: it must NOT be loaded at boot.
   Together these four were 1.76 MB — 76% of the JavaScript this app used to
   block on — for output that does not exist until someone clicks a button.
   Restoring a <script src> for any of them fails here rather than quietly
   putting ~9s back on a cold 3G launch. */
for (const [name, expr] of [
  ['heic2any', 'typeof heic2any === "undefined"'],
  ['jsPDF', '!window.jspdf'],
  ['FindingsReport', 'typeof window.FindingsReport === "undefined"'],
  ['InvoiceReport', 'typeof window.InvoiceReport === "undefined"'],
  ['StatementReport', 'typeof window.StatementReport === "undefined"']
]) {
  check(`${name} NOT loaded at boot`, await page.evaluate(expr));
}

/* …and that each on-demand path actually works, so the assertions above are
   pinning a working lazy load rather than a broken one. Without these, deleting
   the loader entirely would pass every "NOT loaded at boot" check above. */
check(
  'heic2any loads on demand',
  await page.evaluate(`(async () => {
    const el = document.createElement('script');
    el.src = 'vendor/heic2any-0.0.4.min.js';
    const ok = await new Promise((res) => {
      el.onload = () => res(true); el.onerror = () => res(false);
      document.head.appendChild(el);
    });
    return ok && typeof heic2any === 'function';
  })()`)
);

/* loadPdfEngine() has to bring up all three files in the right order and end
   with every global defined. Its own post-load guard would throw otherwise, so
   this resolving at all is the assertion; the explicit checks below say which
   piece is missing when it doesn't. autoTable is instantiated for real, since
   jspdf-autotable registering itself is exactly what load order protects. */
{
  const r = await page.evaluate(`(async () => {
    try { await loadPdfEngine(); } catch (e) { return { e: String(e) }; }
    return {
      jspdf: !!(window.jspdf && window.jspdf.jsPDF),
      autoTable: typeof (window.jspdf && new window.jspdf.jsPDF().autoTable) === 'function',
      findings: typeof window.FindingsReport === 'object',
      invoice: typeof window.InvoiceReport === 'object',
      statement: typeof window.StatementReport === 'object'
    };
  })()`);
  check('PDF engine loads on demand', !r.e, r.e || '');
  if (!r.e) {
    check('  jsPDF defined after load', r.jspdf);
    check('  autoTable registered on jsPDF', r.autoTable);
    check('  FindingsReport registered', r.findings);
    check('  InvoiceReport registered', r.invoice);
    check('  StatementReport registered', r.statement);
  }
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
