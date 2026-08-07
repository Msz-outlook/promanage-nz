# CLAUDE.md — ProManage NZ

Guidance for Claude Code working in this repository.

## What this is

A property-management app for a Christchurch, NZ property manager. It is a
**single-file offline-first PWA**: essentially all of the app lives in
`index.html` (~7.5k lines), backed by Supabase (Postgres + Auth + private
Storage) and IndexedDB for local state.

**There is no build step and no package.json.** You edit `index.html` directly
and open it in a browser. There *is* a test suite, but it runs against the real
page in a real browser rather than importing modules — see "Verifying a change".
Third-party libraries are
vendored into `vendor/` rather than pulled from a CDN, so the app works with no
signal and does not hand a third party a request on every page load.

## Files

| Path | Lines | What it is |
| --- | --- | --- |
| `index.html` | 7752 | The whole app — markup, CSS, PDF report modules, and every feature module |
| `supabase/schema.sql` | 596 | Idempotent schema: `updated_at` triggers, ownership columns, RLS, FKs, indexes, activity-log retention, invoice/statement number uniqueness. Safe to re-run |
| `sw.js` | 187 | Service worker. App-shell cache (`CACHE_NAME = 'promanage-shell-v9'`), navigation falls back to cached `index.html` |
| `vendor/` | — | supabase-js 2.111.0, jsPDF 2.5.2, jspdf-autotable 3.8.2, heic2any 0.0.4 |
| `manifest.json` | — | PWA manifest |
| `scripts/` | 2400 | `check-app.mjs` (static checks, no deps), `smoke-test.mjs` (boots the app in Chromium), `test.mjs` + `tests/` (the suite), `lib/harness.mjs` (shared server + browser). See "Verifying a change" |
| `.github/workflows/` | — | `ci.yml` runs all three check scripts on every push and PR; `keep-alive.yml` pings Supabase twice weekly so the Free project does not auto-pause |
| `docs/REVIEW-2026-08.md` | — | Review ahead of scaling to ~6 properties: backup gap, photo sizing, quota projections |
| `docs/REVIEW-2026-08-quality.md` | — | Quality/performance review: measured boot + sync latency, the escaping and import bugs, and the duplicated-scaffolding recommendation left unimplemented |

**This repo is the deploy root.** GitHub Pages serves every committed file, and
directories without an index are listable. Never commit real owner/tenant data,
generated statements, or PDFs — see `.gitignore`.

## Map of `index.html`

**There are deliberately no line numbers here.** Every one this file used to
carry was wrong — they had drifted by between 111 and 885 lines — and a stale
number is worse than none, because it reads as authoritative and sends you to
the wrong function. Regenerate them instead; this is accurate by construction:

```sh
grep -n "^\s*\(async \)\?function \|^const \|^let \|^/\* =" index.html
```

What follows is the part grep cannot tell you: the order of the file, and what
is unusual about each piece.

### Block 0 — head and PDF report modules

All CSS is inline, above `</head>`. Then the vendored `<script src>` tags
(supabase-js, jsPDF, jspdf-autotable) — **not heic2any, which
`FindingsReport.loadHeic2Any()` fetches on demand**; see "Things not to
simplify".

Then three PDF generators: `FindingsReport` (inspection report),
`InvoiceReport`, `StatementReport`. Each is an IIFE taking `global`, depends
only on the globals loaded above it, and exposes a single
`generate(data, options)`. Each ends by assigning to `global.<Name>`, which is
what the smoke test checks — proof the block ran to completion, not merely that
it parsed.

### Block 1 — the app

In file order:

| Section | What is worth knowing |
| --- | --- |
| App shell, config, auth | `nav()` switches page **and draws it**. `CONFIG` holds the Supabase URL, publishable key and bucket. `BUSINESS_INFO` is printed on every invoice/statement PDF. `LAW_UPDATES_LAST_VERIFIED` dates the static NZ compliance copy |
| IndexedDB + account isolation | `openDB()` — `promanageDB`, `DB_VERSION = 9`, 9 stores (8 synced + `settings`). `enforceLocalDataOwner()` wipes local stores when a different account signs in |
| Sync engine | `fetchRemoteTablePaged` → `pullAndMerge` → `pullAllAndMerge` (concurrent pulls, then draws the visible page). `fullSyncNow()` pushes then pulls, and is the **only** place that tells the user they are offline. `mapRemoteX()` row mappers live here |
| Activity log | Pruned on a retention window at both ends — see "Things not to simplify" |
| Pagination | `getListPage` / `renderPaginationControls` / `LIST_RENDERERS` |
| Inspections | `escapeHtml` is defined here and used by every list renderer. Camera modal, photo refs (`extractStoragePath` / `signStoragePaths` / `resolvePhotoRefs`), and `generateInspectionPDF(id, btn)` — `btn` arrives as `this` from the onclick |
| Compliance | `getPropertyCompliance()` fills defaults for records predating the feature |
| Properties | `findPropertyLinks()` is the delete guard; the database enforces it too |
| Tenants, Maintenance | The plain form of the module shape below |
| Email triage | **Mock mode — no mailbox is connected.** Gated by `DEMO_EMAIL_TRIAGE_DEFAULT` / `demoEmailTriageEnabled()`, off by default so `MOCK_INBOX` cannot invent maintenance jobs on real data |
| Invoices | `GST_RATE = 0.15`, `nextInvoiceNumber()`, `importInvoiceJSON()` |
| Statements | Multi-property blocks, `nextStatementNumber()`, `importStatementJSON()` |
| Financials | The agency's own books, derived live from Owner Statements — revenue is the management fee, **not** the owner's rent |
| Backup / Archive | Two different jobs — see below |
| Dashboard | `INSPECTION_INTERVAL_DAYS = 180`. Service-worker registration is the **last top-level statement in the block**, which is why the smoke test asserting it proves the whole block ran |

### Backup and Archive are not the same thing

**Backup** (`exportAllData` / `importAllData`) is for *restore*: one JSON blob
of every store, photos optionally inlined as data URLs, re-imported after a
wipe. Nothing is ever deleted because of it.

**Archive** (`archiveInspections` / `purgeArchivedPhotos`) is for *records*:
per-inspection folders on an external drive holding the generated `report.pdf`,
the source photos and a `manifest.json` — and it is the only thing in the app
that deletes from Supabase Storage on purpose.

| Function | What it does |
| --- | --- |
| `archiveSupported()` | `showDirectoryPicker` present — Chrome/Edge desktop only |
| `pickArchiveDirectory()` | prompts, stores the handle in the `settings` store |
| `getArchiveDirectory()` | restores the handle; null unless permission is still `granted` |
| `archiveFolderName(insp, addr)` | `YYYY-MM-DD_Address` — date first to sort, address to avoid same-day collisions |
| `archiveOneInspection(dir, insp, addr)` | generate → write → **verify**, then report |
| `verifyArchivedInspection(dir, insp)` | re-opens every recorded file and checks its size |
| `purgeArchivedPhotos(dir)` | deletes Storage copies older than `ARCHIVE_PURGE_AFTER_DAYS` (180), gated on verification |
| `storageUsageEstimate()` | headroom against the Free 1 GB cap, from `photoSizes` recorded at upload |

## Conventions

**Every module follows the same offline-first shape.** When adding one, copy it:

- `toggleXForm(show, record)` — one form for create and edit
- `saveX()` — write to IndexedDB first, then sync in the background
- `renderXList()` — reads IndexedDB, escapes with `escapeHtml`, paginates via `getListPage`
- `deleteX(id)` — sets `pendingDelete` when the record is already synced
- `pushXToBackend(record)` / `syncPendingX()` / `updateXSyncBanner()`
- `mapRemoteX(row)` + a `pullAndMerge(...)` line in `pullAllAndMerge()`

**A new module has to be registered in all of these places**, or it will look
fine on its own page and be stale everywhere else:

1. `pages` and the nav markup
2. `MODULE_RENDERERS` — the module's render + banner
3. `PAGE_MODULES` — which page(s) draw it
4. `pullAllAndMerge()` — the `pullAndMerge(...)` line
5. `fullSyncNow()` — `syncPendingX()`
6. The `online` / `offline` listeners — banner
7. `LIST_RENDERERS` if it paginates

Rendering is page-scoped: a completed sync draws the page on screen and marks
every other module stale, and `nav()` draws a page's stale modules on entry.
That makes 2 and 3 a matched pair — **a module missing from every
`PAGE_MODULES` entry never redraws after a sync, and a page missing from
`PAGE_MODULES` draws nothing on entry.** Both directions are asserted by
`scripts/tests/page-render.test.mjs`, which is the cheapest way to find out.

This replaced a blanket "re-render all ten modules after every sync", which
masked a real gap for a long time: `nav()` did *not* re-render properties,
tenants, maintenance or inspections, and those four stayed correct only because
the sync redrew everything. That is the failure mode to keep in mind here —
stale data that merely looks unchanged is not reported as a bug.

The two `populateXPropertyDropdown()` calls stay in `nav()` and out of the
registry on purpose: both rebuild their `<select>` without preserving its
value, so running them on a sync would clear a half-filled form.

## Top-level code in the script block

The whole app is two inline `<script>` blocks. **A statement that throws at the
top level of one abandons every line after it in that block** — and because the
markup is already on screen and function declarations are hoisted before any
statement runs, the page looks completely normal while nothing behind it is
wired up. Clicks reach handlers that exist but operate on a half-built world.

This is not hypothetical. `const sb = supabase.createClient(...)` once ran
unguarded. When `vendor/supabase-js-2.111.0.umd.js` failed to fetch, `supabase`
was undefined, the line threw, and everything below it never ran: the
`DOMContentLoaded` registration, the `online`/`offline` listeners, the
service-worker registration. `doLogin` was still callable from its inline
`onclick`, so the sign-in button looked alive and did nothing. Worse, `const`
leaves a failed binding in the temporal dead zone, so the first read reported
**`Cannot access 'sb' before initialization`** — a message that describes the
symptom and hides the cause, which is a script tag that 404'd.

So, for anything initialised at the top level:

- **Check the global before dereferencing it.** Every vendored library is a
  plain `<script src>` that can fail independently. The PDF modules already do
  this right (`if (!global.jspdf || !global.jspdf.jsPDF) throw ...`, and the
  same for `heic2any`) — and they do it *inside* `generate()`, so a missing
  library breaks one button instead of the app.
- **Use `let` and catch, not bare `const`,** for anything whose initialiser can
  throw. A failed `const` poisons every later read with a TDZ error that points
  at the wrong place; `let x = null` lets the rest of the app boot and lets the
  one broken feature say what is actually wrong.
- **Record the reason and surface it** where the user will hit it, rather than
  letting the next caller produce an unrelated error — see `backendInitError`
  and `BACKEND_UNAVAILABLE_MESSAGE`.
- **Keep top-level statements to a minimum.** Prefer doing the work in
  `DOMContentLoaded`, where a throw costs you that handler and not the file.

When adding a new vendored library, add its guard at the same time as the
`<script>` tag, and remember `sw.js` (`SHELL_FILES` + `CACHE_NAME`).

## Things not to "simplify"

- **Every branch of a `fetch` handler in `sw.js` resolving to a `Response`.**
  `event.respondWith()` on a promise that resolves to `undefined` fails the
  request outright, and for a `<script src>` that is silent — the library
  simply never loads. `cacheFirstRevalidate` did exactly that for a shell file
  that was neither cached nor reachable (`.catch(() => cached)` with nothing
  cached), which is what made "Cannot access 'sb' before initialization"
  recur rather than clear on reload. A 504 you can see beats an `undefined`
  you cannot.
- **`let sb = null` + the try/catch around `createClient`.** Not a stylistic
  choice — see "Top-level code in the script block" above. Restoring
  `const sb = supabase.createClient(...)` re-arms a failure mode where a single
  missing vendor file silently prevents the entire app from booting.
- **`authHeader()` returning `null` when there is no session.** Never restore
  the old `: CONFIG.SUPABASE_KEY` fallback, and never send a request without
  checking the token first. That key authenticates as `anon`, so `auth.uid()`
  is NULL and every owner-scoped RLS policy matches nothing — and PostgREST
  reports that as `200 []`, not as an error. It is indistinguishable from an
  empty table, so `pullAndMerge()` concluded the server was empty and its
  delete pass cleared every synced record off the device. **This is how the
  app wiped its own local database on 4 Aug 2026** after a failed sign-in left
  the Mac session-less while the `online` listener kept calling `fullSyncNow()`.
  The server copies were never touched, which is the only reason it was
  recoverable. Any new backend call gets a `if(!token)` guard.
- **The empty-list check before the delete pass** in `pullAndMerge()`. A
  permission failure and a genuinely empty table arrive looking identical, so
  the device's last copy is never spent on that ambiguity.
- **Pagination + the delete guard** — the "only an EMPTY page proves we reached
  the end" rule in `fetchRemoteTablePaged()`. A short page must not be treated
  as the last one: PostgREST's `max-rows` can be lower than `SYNC_PAGE_SIZE`, in
  which case every page comes back short, and stopping early would hand the
  delete pass exactly the truncated list this function exists to prevent. It
  looks redundant. It is not.
- **The private Storage bucket.** Photos are stored as `storage:<path>`
  references and signed at display time (`resolvePhotoRefs`). Paths are
  guessable from the address and inspection id, and a public bucket also allows
  listing. `storage:` is deliberately not loadable by `<img src>` so a missed
  resolver step fails loudly instead of leaking a link.
- **`verifyArchivedInspection()` running at PURGE time, not just archive time.**
  This is the only code in the app that deletes photos from Storage on purpose,
  and once it has, the external drive is the *only* copy — there is no mirror.
  The `archivedAt` flag proves the files were written six months ago; it proves
  nothing about whether the drive still holds them today. So purge re-opens
  every file and re-checks its size before deleting, and skips the inspection
  entirely if the drive is absent, a file is missing, or a size differs. Every
  failure path here must resolve to *keep the photos* — the cost of being wrong
  in that direction is a storage-cap warning, and in the other direction it is
  permanent loss of inspection evidence. Do not "optimise" the re-check away on
  the grounds that the archive was already verified.
- **`generateInspectionPDF` refusing on `photosPurgedAt`.** `resolvePhotoRefs`
  returns null for a purged photo and the `.filter(Boolean)` downstream would
  quietly emit a report with no photos in it, under the same filename as the
  real one. Refusing and naming the archive folder is the point.
- **Server-side `updated_at`** (schema.sql §1). Conflict resolution compares
  `updated_at`; letting clients write it means the device with the fastest clock
  wins. It also makes the incremental pull cursor meaningful.
- **`escapeHtml` on every interpolated value** in list renderers — *every* one,
  not just the obviously-textual ones. Numbers, dates, status labels and ids
  all reach a renderer from `importAllData`, which is the one path where an
  arbitrary shape gets into IndexedDB. Thirteen fields across five modules
  executed injected markup because they looked too boring to escape.
- **`escapeJsAttr`, not `escapeAttr`, for anything inside an inline handler**
  (`onclick="fn('${id}')"`). These are not interchangeable and the difference
  is not stylistic. An event-handler attribute is decoded **twice**: the HTML
  parser unescapes it, and only then is the result compiled as JavaScript. So
  `escapeAttr`'s `&#39;` is back to an apostrophe before the compiler sees it,
  and an id of `x'); doSomething(); ('` runs — which it did, in all six
  modules, three of which were already calling `escapeAttr` and looked handled.
  `escapeJsAttr` escapes for the JS string literal first and the HTML attribute
  second; **that order is load-bearing**, because HTML-escaping last is what
  stops a pre-encoded `&#39;` in a stored value surviving the parser as a real
  quote. Use `escapeAttr` for plain attributes (`value=`, `data-`), never here.
- **Guarded sort comparators** — `(b.createdAt||'').localeCompare(a.createdAt||'')`.
  The unguarded form throws on a record without `createdAt`, and the whole list
  fails to render rather than dropping one row. It only reproduces at three or
  more items, because below that V8 never puts the bad record in the `b`
  position — which is exactly why it survived so long.
- **The pulls run concurrently; the pushes do not.** The seven `pullAndMerge()`
  calls are independent and run under one `Promise.all` — serially they cost
  fourteen round trips, 4.3s on mobile latency, for a sync that found nothing.
  The pushes in `fullSyncNowInner()` are ordered because tenants, maintenance,
  inspections and invoices carry a foreign key to `properties`. Do not
  "consistency-fix" the pushes to match the pulls.
- **The vendored libraries.** Do not swap them back to CDN `<script>` tags.
- **`heic2any` loaded on demand, not as a `<script src>`.** It is 1.32 MB —
  69% of the JavaScript that used to block the first paint — for a library that
  does nothing until an inspection PDF is built from a HEIC photo. It stays in
  `SHELL_FILES` so it is still pre-cached and still works offline; pre-caching
  a file and blocking on it are different things. `smoke-test.mjs` asserts it is
  **absent** at boot, so re-adding a tag fails rather than quietly costing every
  launch ~6s on a slow connection.
- **The 3s deadline on the service worker's navigation fetch.** Network-first
  with no timeout is not the same as network-first: "unreachable" rejects,
  "answering very slowly" does not, and the second one hung a cold launch on a
  blank page with a working shell sitting in the cache.
- **Activity-log retention windows.** The pull filter and
  `pruneLocalActivityLog()` must use the same cutoff, or each undoes the other
  on every sync forever.
- **Passing the button into PDF generators.** `generateInspectionPDF(id, btn)`
  takes the element as `this` from the onclick; the global `event` is not
  reliable after the first `await`.

## Supabase

Project `ilxjyhnbnsufeomnkmsg` (`promanage-nz`, ap-southeast-2), org on the
**Free** plan.

- `CONFIG.SUPABASE_KEY` is the **publishable** key and is meant to be in this
  served file. A service-role key must never land here — `check-app.mjs` fails
  the build if one does.
- RLS is owner-scoped, one policy per command; every table carries `user_id`.
- Re-running `supabase/schema.sql` is safe. It fails loudly rather than
  half-applying if it cannot determine ownership of existing rows.
- Check `get_advisors` after any DDL change.

### Known open item

Auth **leaked-password protection (HaveIBeenPwned) is disabled**, and shows up
as a `WARN` in the security advisors. It requires the **Pro plan** — it is not
available to toggle on Free. Enable at
Authentication → Sign In / Providers → Email → "Prevent use of leaked passwords"
once the project is upgraded.
[Docs](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)

## Verifying a change

Three scripts. Run all three before pushing — CI (`.github/workflows/ci.yml`)
runs exactly these:

```sh
node scripts/check-app.mjs      # static checks, no dependencies
node scripts/smoke-test.mjs     # boots the app in a real browser
node scripts/test.mjs           # the test suite (145 cases)
```

`check-app.mjs` replaces the old manual `node --check` ritual and adds the
assertions that ritual could not make: that every `<script src>` exists on
disk, that `SHELL_FILES` in `sw.js` covers them, and that no service-role key
has landed in `index.html`. Pass `--base origin/main` (CI does this on pull
requests) to also assert that a change to a shell file came with a `CACHE_NAME`
bump — installed clients keep serving the old shell otherwise.

`smoke-test.mjs` needs Playwright:

```sh
npm install --no-save playwright && npx playwright install chromium
```

It checks **side effects of top-level statements**, not the presence of
functions — declarations are hoisted, so `typeof saveInspection === 'function'`
stays true even when the block defining it threw on its first line. The last
assertion is that the service worker registered, which is the final top-level
statement in block 1: if that ran, the whole block ran. This is the specific
regression described in "Top-level code in the script block" above, and
removing a file from `vendor/` is a quick way to confirm the test still
catches it.

### The test suite

`scripts/test.mjs` runs `scripts/tests/*.test.mjs` against the **real functions
in the real page**, not against a copy.

This needs no change to `index.html`: in a classic script, top-level `function`
declarations become properties of `window` and top-level `const`/`let` land in
the global lexical environment, so both are reachable as bare identifiers inside
`page.evaluate()` — a test can call `escapeHtml()` or read `GST_RATE` directly.
That is why the runner is browser-based rather than Node-based. The
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

A case named `CURRENT BEHAVIOUR:` pins a known bug from
`docs/REVIEW-2026-08.md`, so fixing it is a deliberate, visible change rather
than an accidental one. Update the case as part of any fix that changes it.
One is live: `classifyStatementExpenseLine()` still defaults an unrecognised
line to `disbursement` (finding 13 — mitigated by the "Unreviewed lines" panel
on Financials rather than fixed, since redefining what counts as a disbursement
is a bigger call than making the miscount visible).

None of this replaces using the thing. Open `index.html` in a browser and
exercise the affected module both online and offline (DevTools → Network →
Offline).
