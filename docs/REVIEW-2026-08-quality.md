# ProManage NZ — quality, correctness and performance review

**Date:** 7 August 2026
**Scope:** code quality, correctness bugs, redundant code, and a measured
performance assessment — asked for as "I don't want that web app to have a
slight friction when using it".
**Commit reviewed:** `a282376`
**Companion review:** [`REVIEW-2026-08.md`](REVIEW-2026-08.md) (5 Aug 2026)
covered backups, photo sizing and quota. This one does not repeat it.

Every measurement below was taken in Chromium against the real page, and every
bug was reproduced by executing it rather than by reading the code. The
harnesses are described under [Verification](#verification).

---

## Summary

**At six properties this app is not slow, and the sync engine remains the best
part of the codebase.** The friction worth caring about was never throughput —
renders are comfortable well past any portfolio this business will have. It was
*latency*, in two places, plus a set of correctness bugs that stay invisible
right up until they aren't.

| | Before | After |
| --- | --- | --- |
| Blocking JavaScript | 1,921 KB | **206 KB** |
| First paint, throttled 3G phone | 11,788 ms | **2,792 ms** |
| First paint, mid-range phone | 388 ms | **112 ms** |
| Full sync, nothing changed, 300 ms RTT | 4,291 ms | **641 ms** |
| Sync render tail, 6 properties | 38.6 ms | **5.4 ms** |
| Test cases | 118 | **151** |

The three headline findings:

1. **HTML injection executed in every list renderer**, and the id-escaping that
   three modules already applied never worked — it was defending the wrong
   layer. Fixed.
2. **A sync cost fourteen sequential HTTP round trips** even when nothing had
   changed, on every app open, focus and reconnect. Fixed.
3. **76% of the JavaScript blocking the first paint was never used on any
   screen** — a HEIC converter, plus the entire PDF stack. None of it does
   anything until a button is clicked. Both now load on demand. Fixed.

What was *not* changed, deliberately: roughly 700 lines of duplicated module
scaffolding. See [Redundant code](#redundant-code).

---

## Performance

### How it scales

Ten modules rendered, at increasing store sizes:

| Records per store | All modules | DOM nodes | JS heap |
| --- | --- | --- | --- |
| 6 (the real portfolio) | 23 ms | 2,037 | 9.1 MB |
| 100 | 90 ms | 6,677 | 8.0 MB |
| 1,000 | 875 ms | 47,757 | 10.2 MB |
| 5,000 | 2,566 ms | 230,348 | 21.3 MB |

Growth is roughly linear and there is no cliff. Page-switch latency at 5,000
records per store ranged from 14 ms (dashboard) to 95 ms (statements) — still
under the 100 ms threshold where an interaction stops feeling instant, at a
scale ~800× the real one.

Pagination is doing its job on the list pages. The DOM-node growth comes from
the **Dashboard and Compliance cards, which render every property
unpaginated**. That is irrelevant at six properties and is why 5,000 costs
230k nodes. Left alone: adding pagination to a card that will show six rows
would be complexity bought for nothing.

### Finding 1 — a sync was fourteen sequential round trips *(fixed)*

`pullAllAndMerge()` pulled seven tables one after another. Each table needs two
requests to walk, because only an empty page proves the walk reached the end
(`fetchRemoteTablePaged` — and that rule is correct; see CLAUDE.md on why short-
page detection is unsafe under PostgREST's `max-rows`).

So a sync that found **nothing changed** still cost fourteen serial round trips.
Measured against a 300 ms mobile latency on a six-property portfolio:
**4,291 ms**. This runs at login, on the `online` event, whenever the tab
regains focus, and every 20 minutes.

The seven pulls are independent — each reads one remote table into one local
store, keeps its own cursor, and catches its own errors — so they now run
concurrently. **4,291 ms → 641 ms**, a 6.7× improvement, with the same fourteen
requests.

> **The pushes stay sequential and must.** Tenants, maintenance, inspections
> and invoices all carry a foreign key to `properties`, so a property has to
> land on the server before anything that references it. That ordering is
> load-bearing, not incidental, and there is now a comment in
> `fullSyncNowInner()` saying so.

### Finding 2 — 76% of the blocking JavaScript was never used *(fixed)*

| Vendored library | Size | Share |
| --- | --- | --- |
| `heic2any` | 1,320 KB | **69%** |
| `jspdf` | 357 KB | 19% |
| `supabase-js` | 206 KB | 11% |
| `jspdf-autotable` | 38 KB | 2% |

`heic2any` is touched in exactly two places, both inside
`FindingsReport.normalizeToDataUrl`, and only when a photo is HEIC/HEIF. Nothing
on any screen needs it until an inspection PDF is generated.

It is now fetched on demand by `loadHeic2Any()`, and the whole PDF stack —
`jspdf`, `jspdf-autotable` and the three report generators — by
`loadPdfEngine()`, on the same reasoning: 438 KB that produces nothing until
someone asks for a document. **supabase-js is the only library left blocking
the first paint**, because auth runs at boot and nothing is on screen until it
answers.

**All four remain in `SHELL_FILES`, so they are still pre-cached and still work
with no signal** — pre-caching a file and blocking the first paint on it are
different things, and only the second was costing anything.

| | Before | After |
| --- | --- | --- |
| Blocking JS | 1,921 KB | 206 KB |
| FCP, desktop | 192 ms | 56 ms |
| FCP, mid-range phone (4× CPU) | 388 ms | 112 ms |
| FCP, slow phone on 3G (6× CPU, 1.6 Mbps) | 11,788 ms | 2,792 ms |

### Finding 3 — a cold launch could hang on a weak connection *(fixed)*

The service worker served navigations network-first with no timeout. "The
network is unreachable" and "the network is answering, very slowly" are
different failures and **only the first one rejects**. On a weak connection —
which for this app means standing inside someone's rental — `fetch()` neither
resolved nor rejected for as long as the browser was willing to wait, and the
app sat on a blank page with a perfectly good copy of itself in the cache.

`navigateWithTimeout()` now races the network against a 3 s deadline and serves
the cached shell if the network loses. The request is **not** aborted: it keeps
running and refreshes the cache for next time. Every path still resolves to a
`Response`, per the standing warning in CLAUDE.md.

### Finding 4 — every sync redrew every page *(fixed)*

A completed sync re-rendered all ten modules and performed **23 separate
full-store IndexedDB reads**, whatever page was on screen, to update the one
page the user could see.

It now draws the current page and marks the rest stale; `nav()` catches a page
up on entry. **38.6 ms → 5.4 ms** at six properties, 2,337 ms → 665 ms at 5,000.

> This was the riskiest change in the review, for a reason worth recording.
> `nav()` did **not** re-render Properties, Tenants, Maintenance or
> Inspections. Those four refreshed *only because* the sync redrew everything
> unconditionally. Deferring renders without giving them a path back would have
> frozen them on any device receiving changes made elsewhere — and data that is
> merely stale, rather than visibly wrong, is not the kind of bug anyone
> reports.
>
> Both directions are now table-driven (`MODULE_RENDERERS` + `PAGE_MODULES`)
> and both are asserted by tests: every module must be reachable from some
> page, and every page must map to modules that exist.

Two modules were fixed by the registry simply being complete: `renderFinancials`
and `renderEmailTriageList` were never in `APP_RENDERERS`, so neither was drawn
at sign-in or first load — only on navigation.

---

## Correctness

### Finding 5 — HTML injection executed in every list renderer *(fixed)*

`escapeHtml` was applied to the obvious free-text fields — addresses, tenant
names, issue descriptions — and not to numbers, dates, enum labels or ids. A
payload landed and ran from thirteen fields:

| Module | Fields that executed |
| --- | --- |
| Invoices | `invoiceNumber`, `issueDate`, `dueDate` |
| Statements | `statementNumber`, `periodStart`, `periodEnd` |
| Properties | `bedrooms`, `tenancy`, `rentPerWeek`, `status` |
| Tenants | `leaseStart`, `leaseEnd`, `rentPerWeek`, `arrearsAmount` |
| Maintenance | `priority`, `status` |
| Compliance | overdue property addresses in the summary cards |

Also unescaped: `value="${...}"` on the compliance modal's date inputs and on
the invoice/statement numeric line-item inputs.

### Finding 6 — the id escaping defended the wrong layer *(fixed)*

This is the more serious half, because it looked handled.

Every module interpolates a record id into an inline handler —
`onclick="fn('${id}')"` — and Properties, Tenants and Maintenance already ran it
through `escapeAttr`, whose comment claimed to cover exactly this case.

It doesn't. **An event-handler attribute is decoded twice**: the HTML parser
unescapes the attribute value, and only *then* is the result compiled as
JavaScript. `escapeAttr` turns an apostrophe into `&#39;`, the parser turns it
straight back into an apostrophe, and the compiler sees a closed string. All six
modules executed an id of `x'); doSomething(); ('` — with `escapeAttr` applied.

`escapeJsAttr()` escapes for the JS string literal first and the HTML attribute
second, so what reaches the compiler is still a string literal. **The order is
load-bearing:** HTML-escaping last is what stops a pre-encoded `&#39;` in a
stored value surviving the parser as a real quote.

> **Severity, honestly.** This is a single-user app behind owner-scoped RLS, so
> there is no second user to attack. The realistic vector is the JSON import
> path, which the app explicitly supports for statements and invoices "produced
> by an external generator", plus a tampered backup file. That is narrow — but
> the page holds a live Supabase session, so anything that executes inherits
> full access to the data. Worth fixing properly; not worth alarm.

### Finding 7 — a record without `createdAt` blanked a whole page *(fixed)*

Five renderers sorted with `b.createdAt.localeCompare(a.createdAt)`, unguarded.
With a record missing `createdAt` this throws — but **only once the list has
three or more items**, because below that V8 never places the bad record in the
`b` position. Two rows happened to survive, which is why it went unnoticed.

The whole list then failed to render, not one row. `renderStatementsList` already
guarded this with `(b.createdAt||'')`; the other five now match.
`renderInspectionList` had the same class of bug on a missing `areas` array
(`.reduce` of undefined).

### Finding 8 — `importAllData` wrote whatever it was given *(fixed)*

The enabler for findings 5 and 7. It wrote any object carrying an `id`, with no
shape validation — and it is the *only* path where an arbitrary shape reaches
IndexedDB. Everything else builds a record from a form or from `mapRemoteX()`,
which is why the renderers were written assuming their fields exist.

Records are now filtered (`isImportableRecord`) and the few fields renderers
index into without checking are filled in (`normaliseImportedRecord`). It fills
gaps; it does not invent business data — a backup missing an address should look
wrong, not plausible.

### Finding 9 — fourteen hardcoded nav indices *(fixed)*

`document.querySelectorAll('.nav-item')[8]` and thirteen like it. Every one was
correct on the day it was written, and every one silently points at the wrong
page the moment a nav item is added or reordered. They were also unnecessary:
`nav()` already falls back to `.nav-item[data-page="<id>"]` when `el` is null.
All fourteen now pass `null`.

---

## Redundant code

**Not changed.** Recorded here as the next piece of work, with a
recommendation, because it is a large diff through the most safety-critical
code in the app and the duplication is costing clarity rather than correctness.

| What | Size | Notes |
| --- | --- | --- |
| `pushXToBackend` / `syncPendingX` | ~390 lines across 7 modules | Differ only in table name and field mapping |
| `updateXSyncBanner` | 6 wrappers, 7 lines each | Differ only in three element-id suffixes and a store name |
| Email Triage | 263 lines | Shipped but disabled (`DEMO_EMAIL_TRIAGE_DEFAULT = false`), mock inbox, no mailbox connected |
| `dateAddDaysStr` | 5 lines | Never called — **deleted** |

The push functions are the interesting case: `mapRemoteX()` already exists as
the inverse of the field mapping each one inlines, so the shape of the fix is
visible. A single `pushToBackend(record, table, mapLocalToRemote)` plus a
per-module descriptor would collapse ~390 lines to well under 100.

**Recommended, with two conditions.** Do it as its own change, with nothing
else in the diff; and do it *after* the property-delete 409 handling is lifted
out, because `pushPropertyToBackend` is the one that legitimately differs (it
treats a 409 as `blocked` rather than retrying forever, which is correct and
must not be flattened away).

The banner wrappers are a smaller, safer version of the same job —
`applySyncBannerState` is already shared, so all that is left is a table of
`{store, bannerId, statusId, pendingId}`. That one is worth doing on its own.

Email Triage is a judgement call, not a defect: it is dead weight in the shipped
file, but it is also a feature in waiting. If no mailbox is going to be
connected, delete it; if one is, leave it.

---

## Is this a normal way to build a web app?

A direct answer, since it was asked directly: **no, it is not mainstream — and
it is a defensible choice here.**

What is unusual is not the amount of JavaScript. 7,752 lines is an ordinary
mid-sized front end; most apps this size just spread it over 60 files. What is
unusual is **no build step, no package.json, one file, vendored dependencies.**

What that buys, in this specific situation:

- The repo *is* the deploy root. Push and it is live, with nothing in between
  that can fail.
- No dependency graph, so no npm-audit churn and no upstream release changing
  behaviour under you.
- It genuinely works with no signal, which for a property manager standing in a
  rental in Riccarton is the actual requirement.
- One person can hold the whole thing in their head.

What it costs:

- **No module boundaries.** This is the real cost, and it is exactly why the
  seven near-identical sync modules exist — there is no natural seam to factor
  them behind, so the copy-paste is the path of least resistance every time.
- Tests have to boot a browser to reach a function, which is why
  `scripts/test.mjs` works the way it does. That is a clever workaround, but it
  is a workaround.
- No type checking and no linting, so the escaping gaps in finding 5 were
  invisible to tooling. A linter would not have caught them either, in fairness
  — but a template-escaping rule would have.

**Recommendation: keep the architecture.** The constraints that produced it are
real and haven't changed. The thing to watch is not the line count of
`index.html` — it is the duplication, which is what will actually make a change
expensive. When a new module means copying 60 lines of sync scaffolding for the
eighth time, that is the signal to collapse it, not to adopt a bundler.

---

## Should the app be spread over multiple files?

**Yes — for exactly one reason, and it is not maintainability.** Split to make
code lazy-loadable. Do not split to make it tidier.

### The thing splitting does not fix

Start here, because it is the assumption most likely to be wrong: **splitting
files does not remove duplication.** The seven near-identical
`pushXToBackend`/`syncPendingX` pairs are not duplicated because they lack file
boundaries — they are duplicated because they lack an abstraction. Putting each
one in `invoices.js`, `tenants.js` and so on leaves exactly the same 390 lines,
now harder to compare side by side. Collapsing them into a table-driven helper
works just as well inside one file and is the change actually worth making.

So the maintainability case for splitting is weaker than it looks. What is left
is a real performance case.

### What the payload is actually made of

After this review, 601 KB of JavaScript still blocks the first paint:

| | Size | Needed at boot? |
| --- | --- | --- |
| `jspdf` | 357 KB | **No** — only to generate a PDF |
| `jspdf-autotable` | 38 KB | **No** — same |
| PDF report modules (in `index.html`, ~1,083 lines) | 43 KB | **No** — same |
| `supabase-js` | 206 KB | Yes — auth runs at boot |

**438 KB — 73% of what still blocks — exists to generate PDFs**, which happens
when someone clicks a button, not on every launch. That is a bigger lever than
anything left in this review, and it is the same pattern already proven here on
`heic2any`.

Feasibility is confirmed, not assumed: `FindingsReport`, `InvoiceReport` and
`StatementReport` are touched at exactly four call sites, all inside
user-triggered `await`s (`generateInspectionPDF`, `generateInvoicePDF`,
`generateStatementPDF`, `archiveOneInspection`). **Nothing at boot depends on
them.**

### Recommended: one split, and it is small — **now implemented**

> **Implemented.** Blocking JavaScript went from 601 KB to **206 KB**, and
> first paint on the throttled 3G profile from 5,292 ms to **2,792 ms**. The
> prediction below said "~163 KB"; the real figure is 206 KB because that
> estimate folded the 43 KB of inline report modules (part of `index.html`,
> not a separate transfer) into the vendor total. Measured honestly the change
> removed **438 KB of blocking bytes**: 395 KB of vendor JavaScript, plus
> 43 KB off `index.html`, which fell from 370 KB to 333 KB.
>
> **The cost it introduces**, measured at the genuine worst case — slow 3G, no
> service worker, nothing cached — is **3.2 s on the first PDF click of a
> session**, paid once, on a screen where a document is already being awaited.
> With the service worker active (every visit after the first) it is **74 ms**,
> and every later click is 0 ms. Set against roughly 9 s removed from *every*
> launch, on every device, forever.

Move the three PDF modules out of `index.html` into a single
`reports/pdf-reports.js`, and load it — together with `jspdf` and
`jspdf-autotable` — on demand, the way `loadHeic2Any()` already does.

- Blocking JS: **601 KB → ~163 KB**, a further 73% cut.
- `index.html` drops from 7,752 to ~6,670 lines as a side effect.
- The PDF button gets slower the first time it is pressed, once per session,
  on a screen where the user is already waiting for a document to render.
- All three files stay in `SHELL_FILES`, so offline PDF generation is unaffected.

Cost: the smoke test's `FindingsReport registered` assertions must be inverted
the way `heic2any`'s were, and `check-app.mjs`'s existing lazily-loaded-vendor
check already covers the new path.

### Not recommended: splitting the app itself

If `index.html` keeps growing, block 1 could be split into several **classic**
`<script src>` files. This is the safe form, and it is worth knowing why:
classic scripts share one global scope, so `escapeHtml` defined in one file is
callable from another *and* stays reachable as a bare identifier inside
`page.evaluate()`. The 145-case test suite keeps working untouched.

**ES modules would break all 145 tests.** Module top-level declarations are
module-scoped, not properties of `window`, so `app(() => escapeHtml(...))` stops
resolving — as does `page-render.test.mjs` reading `staleModules` and swapping
entries in `MODULE_RENDERERS`. You would have to either export everything to
`window` by hand (defeating the point) or rewrite the runner to import modules,
which tests a copy rather than the page. `CLAUDE.md` records that this is the
whole reason the runner is browser-based.

Even in its safe form, do the deduplication first. Splitting an eight-fold
duplication across eight files makes it permanent.

### Risk register

| Risk | Severity | Notes |
| --- | --- | --- |
| **ES modules break the test suite** | **High** | 145 cases stop resolving bare identifiers. This is the single strongest argument against a module refactor |
| **More `<script src>` = more independent silent failures** | **Medium** | Each tag fails on its own, and a missing one has already taken this app down once — see CLAUDE.md. `check-app.mjs` and `SHELL_FILES` mitigate it, but the surface grows with every file |
| **A build step costs "the repo is the deploy root"** | **Medium** | Push-and-it's-live is a real property of this project. A bundler means CI has to build before Pages serves, and adds a class of failure that currently cannot happen |
| **More files, more `CACHE_NAME` discipline** | **Low** | Every new shell file must join `SHELL_FILES` and every change must bump the cache. Already enforced by `check-app.mjs --base` |
| **More requests on a cold load** | **Low** | HTTP/2 multiplexes, and the service worker pre-caches after the first visit |
| **Lazy PDF: first click is slower** | **Low** | ~395 KB fetched once per session, on a screen where a document is already being awaited. Pre-cached, so offline is unaffected |

### Pros and cons, plainly

**Pros of splitting**

- Rarely-used code can be lazy-loaded — the only argument that pays measurably
  here, and it is worth 438 KB.
- A throw at the top of one file no longer abandons the rest of the app; the
  blast radius of the failure mode CLAUDE.md documents gets smaller.
- Smaller diffs, and review that fits on a screen.

**Cons of splitting**

- Does nothing about the duplication, which is the actual maintainability
  problem.
- Multiplies the independent-load-failure surface that has already bitten this
  project once.
- With ES modules specifically: costs the test suite its design.
- With a bundler: costs the deploy model.
- Merge-conflict and parallel-work benefits do not apply — there is one
  developer.

### Verdict

Split the PDF machinery out and lazy-load it: **438 KB, verified feasible,
same pattern as `heic2any`.** Leave the rest of `index.html` in one piece and
spend the effort on the ~700 lines of duplication instead. Revisit only if a
second developer joins or the file passes ~10k lines — and if you do, use
classic scripts, not ES modules.

---

## Verification

All three scripts pass, and CI runs exactly these:

```sh
node scripts/check-app.mjs      # static checks
node scripts/smoke-test.mjs     # boots the app in a real browser
node scripts/test.mjs           # 145 cases (was 118)
```

New guardrails added by this review:

- **`check-app.mjs`** now asserts that vendor paths referenced from JavaScript
  exist on disk. `heic2any` no longer has a `<script src>` for the existing
  check to find, so without this, re-versioning the file would pass every check
  and surface months later as one failed HEIC conversion.
- **`smoke-test.mjs`** now asserts the *inverse* for `heic2any` — it must **not**
  be loaded at boot — plus that the on-demand path works, so the assertion pins
  a working lazy load rather than a broken one. `jspdf-autotable` is now checked
  too; it never was.
- **`escaping.test.mjs`** — 9 new cases covering `escapeJsAttr`, including the
  double-decode that defeated `escapeAttr`, backslash ordering, and U+2028/9.
- **`import-safety.test.mjs`** — 10 new cases on the import guards, including
  the 3-row reproduction of finding 7.
- **`page-render.test.mjs`** — 8 new cases pinning the staleness contract, with
  a named case for the four modules `nav()` never used to redraw.

Findings 5, 6 and 7 were each reproduced in a browser before the fix and
re-run after it. Finding 4's end-to-end behaviour was verified separately: after
a sync from the dashboard, Properties is deferred, the dashboard is drawn
immediately, and Properties and Tenants both show remote data with their sync
banners updated on first navigation and again on return.

None of this replaces using the thing. Open `index.html`, exercise each module
online and offline (DevTools → Network → Offline), and generate one inspection
PDF from a HEIC photo to exercise the lazy loader.

---

## Suggested order of work from here

1. ~~**Lazy-load the PDF machinery.**~~ **Done** — 601 KB → 206 KB blocking,
   3G first paint 5,292 ms → 2,792 ms. See the section above for the measured
   before/after and the first-click cost it trades against.
2. **Collapse the six sync-banner wrappers.** Small, safe, self-contained.
3. **Decide on Email Triage** — connect a mailbox or delete the 263 lines.
4. **Collapse `pushXToBackend` / `syncPendingX`**, on its own, after lifting the
   property-delete 409 handling out first.
5. Leave the unpaginated Dashboard and Compliance cards alone until there is a
   portfolio that makes them slow. There isn't one, and there won't be soon.

Not on this list, deliberately: splitting `index.html` for its own sake, and
anything involving a bundler. See the section above for why.
