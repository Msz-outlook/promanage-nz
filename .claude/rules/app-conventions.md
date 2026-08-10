---
paths:
  - "index.html"
---

# Adding to `index.html`

## Every module follows the same offline-first shape

When adding one, copy it:

- `toggleXForm(show, record)` — one form for create and edit
- `saveX()` — write to IndexedDB first, then sync in the background
- `renderXList()` — reads IndexedDB, escapes with `escapeHtml`, paginates via `getListPage`
- `deleteX(id)` — sets `pendingDelete` when the record is already synced
- `pushXToBackend(record)` / `syncPendingX()` / `updateXSyncBanner()`
- `mapRemoteX(row)` + a `pullAndMerge(...)` line in `pullAllAndMerge()`

## A new module has to be registered in all seven places

Or it will look fine on its own page and be stale everywhere else:

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

The whole app is one inline `<script>` block. **A statement that throws at its
top level abandons every line after it** — and because the markup is already on
screen and function declarations are hoisted before any statement runs, the
page looks completely normal while nothing behind it is wired up. Clicks reach
handlers that exist but operate on a half-built world.

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
