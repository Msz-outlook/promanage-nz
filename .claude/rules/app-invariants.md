---
paths:
  - "index.html"
---

# Things in `index.html` not to "simplify"

Every entry here looks redundant and is not. Most were written after the thing
they prevent had already happened once.

## Data loss

- **`let sb = null` + the try/catch around `createClient`.** Not a stylistic
  choice — see "Top-level code in the script block" in
  `.claude/rules/app-conventions.md`. Restoring
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
  delete pass exactly the truncated list this function exists to prevent.
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
- **`archiveOneInspection()` returning before it creates a folder when
  `loadPdfEngine()` fails.** It uses `loadPdfEngine()` directly rather than
  `ensurePdfEngine()` — no alert per inspection, a reason string for the
  summary — and it must fail *closed*. An inspection marked archived is one
  whose photos become eligible for permanent deletion 180 days later, so a
  report that was never generated must never look like one that was.
  `pdf-engine.test.mjs` pins this, and the case fails if the guard is removed.
- **`generateInspectionPDF` refusing on `photosPurgedAt`.** `resolvePhotoRefs`
  returns null for a purged photo and the `.filter(Boolean)` downstream would
  quietly emit a report with no photos in it, under the same filename as the
  real one. Refusing and naming the archive folder is the point.

## Security

- **The private Storage bucket.** Photos are stored as `storage:<path>`
  references and signed at display time (`resolvePhotoRefs`). Paths are
  guessable from the address and inspection id, and a public bucket also allows
  listing. `storage:` is deliberately not loadable by `<img src>` so a missed
  resolver step fails loudly instead of leaking a link.
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

## Rendering and correctness

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
- **Passing the button into PDF generators.** `generateInspectionPDF(id, btn)`
  takes the element as `this` from the onclick; the global `event` is not
  reliable after the first `await`.

## Theming

- **Colours living in the token blocks, never in a rule.** A hex inside a rule
  is a colour that cannot follow the theme, and it looks perfect to whoever
  added it — in whichever theme they happened to have open. Six were found this
  way when dark mode went in (the alert borders, `.prog-fill`, the three status
  dots). `theme.test.mjs` fails on any rule outside `:root` that names a colour,
  and on any `:root` colour token with no `[data-theme="dark"]` counterpart.
  The same rule applies to the PDFs, where the token block is `MODERNIST` —
  see `reports/CLAUDE.md`.
- **`color-scheme` on both token blocks.** One line each, and it is what makes
  the browser's own widgets follow the theme: the select popup, the date picker,
  scrollbars, autofilled fields. Drop it and the date picker is not merely
  light, it is unreadable — Chrome draws dark text into it on the assumption
  the field is light.
- **`beforeprint` forcing light.** Browsers drop background colours when
  printing but keep text colours, so printing in dark mode puts `#ececea` on
  white paper — a page that reads as blank. The 🖨 button is a real feature
  here, and this also covers Ctrl+P, which the button does not. It swaps the
  attribute rather than duplicating the palette into `@media print`, so there
  is no third copy to keep in step.

## Loading

- **The vendored libraries.** Do not swap them back to CDN `<script>` tags.
- **`heic2any` and the PDF engine loaded on demand, not as `<script src>`.**
  Between them 1.76 MB, for code that does nothing until a button is clicked —
  see the loading table in `.claude/rules/app-architecture.md`.
  `smoke-test.mjs` asserts every one is **absent** at boot *and* that each
  on-demand path works, so re-adding a tag fails rather than quietly putting
  ~9s back on a cold 3G launch — and deleting a loader fails too, rather than
  passing the absence checks.
- **The order inside `PDF_ENGINE_FILES`, and that `loadPdfEngine()` awaits each
  file in turn.** `jspdf-autotable` patches jsPDF's prototype to add
  `doc.autoTable`, so evaluating it first registers nothing and every table in
  every report silently disappears — a broken PDF, not an error. `Promise.all`
  here would be a race that passes most of the time.
