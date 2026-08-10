# The checks

Loaded when you read anything in `scripts/`. CI (`.github/workflows/ci.yml`)
runs exactly these three, in this order:

```sh
node scripts/check-app.mjs      # static checks, no dependencies
node scripts/smoke-test.mjs     # boots the app in a real browser
node scripts/test.mjs           # the test suite (172 cases)
```

## `check-app.mjs`

Replaces the old manual `node --check` ritual and adds the assertions that
ritual could not make: that every `<script src>` exists on disk, that every
lazily-loaded `vendor/` or `reports/` path does too, that `SHELL_FILES` in
`sw.js` covers them, and that no service-role key has landed in `index.html`.

Pass `--base origin/main` (CI does this on pull requests) to also assert that a
change to a shell file came with a `CACHE_NAME` bump — installed clients keep
serving the old shell otherwise.

## `smoke-test.mjs`

Needs Playwright:

```sh
npm install --no-save playwright && npx playwright install chromium
```

It checks **side effects of top-level statements**, not the presence of
functions — declarations are hoisted, so `typeof saveInspection === 'function'`
stays true even when the block defining it threw on its first line. The last
assertion is that the service worker registered, which is the final top-level
statement in the app block: if that ran, the whole block ran. This is the
regression described in `.claude/rules/app-conventions.md`, and removing a file
from `vendor/` is a quick way to confirm the test still catches it.

## The test suite

`scripts/test.mjs` runs `scripts/tests/*.test.mjs` against the **real functions
in the real page**, not against a copy.

This needs no change to `index.html`: in a classic script, top-level `function`
declarations become properties of `window` and top-level `const`/`let` land in
the global lexical environment, so both are reachable as bare identifiers
inside `page.evaluate()` — a test can call `escapeHtml()` or read `GST_RATE`
directly. That is why the runner is browser-based rather than Node-based. The
alternatives were to extract the logic into a module (a refactor this project
does not want) or to re-implement it in the test, which would test the copy.

Writing a suite:

```js
export const name = 'dates';
export default ({ test, app, eq, deepEq, ok, notOk }) => {
  test('parses dd/mm/yyyy, not mm/dd/yyyy', async () => {
    eq(await app((s) => formatDateNZ(parseFlexibleDate(s)), '5/8/2026'), '05 Aug 2026');
  });
};
```

`app(fn, arg)` is `page.evaluate` — one optional argument, which must be
JSON-serialisable, and `fn` closes over nothing from the test file. Return a
plain value: a `Date` will not survive the trip, so format it inside the page.

**The page is booted once and shared by every suite**, so tests must not depend
on mutable app state or on each other. Assert on pure functions and on values
derived from arguments you pass in. `pagination.test.mjs` writes to the shared
`pageState`, so it resets the key it uses in every case — follow that pattern
if you touch module-level state.

If the page throws while booting, the runner refuses to run rather than
reporting a suite of misleading passes — hoisting would leave every function
callable against a world that was never built.

## `CURRENT BEHAVIOUR:` cases

A case named that way pins a known bug from `docs/REVIEW-2026-08.md`, so fixing
it is a deliberate, visible change rather than an accidental one. Update the
case as part of any fix that changes it.

One is live: `classifyStatementExpenseLine()` still defaults an unrecognised
line to `disbursement` (finding 13 — mitigated by the "Unreviewed lines" panel
on Financials rather than fixed, since redefining what counts as a disbursement
is a bigger call than making the miscount visible).
