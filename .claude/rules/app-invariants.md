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
  is NULL, `current_account_id()` resolves to NULL with it, and every
  account-scoped RLS policy matches nothing — and PostgREST
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

## Access — two logins, one account

- **`ACCESS_PROFILES` hides pages. RLS decides what anyone may touch.** The
  profiles in `index.html` exist so a casual staff login is not shown eight
  pages that would render empty and four buttons that would fail; they are not
  a permission system and cannot be one, because everything they do is a few
  keystrokes away in a console. Every restriction they express is *also* an
  RLS policy in `supabase/schema.sql` §5. Adding a page to a profile without
  widening the policy gives someone an empty page; widening the policy without
  the profile gives them a page they cannot find. Do both, in one change.
- **The `deleteBlockedByRole()` guard at the top of every `deleteX()`.** This
  is the exception to the paragraph above — the one client-side rule doing
  real work, and it must not be deleted on the grounds that the policy already
  covers it. PostgREST answers a `DELETE` that matched **no rows** with `204`,
  exactly as it answers one that deleted something, so a delete RLS refused
  reads here as a success and the local copy is dropped. On inspections it is
  worse: `deleteInspection()` removes the photos from Storage *before* it
  sends the row delete, and `deletePhotosFromStorage()` swallows per-object
  failures. Storage refuses a member's object deletes too (§5), so the worst
  case today is a record that reappears on the next pull rather than photos
  that do not — that is defence in depth working, not a reason to remove a
  layer.
- **`purgeArchivedPhotos()` is owner-only, gated in `enterApp()`.** Same
  swallowed failure, opposite direction: a member's Storage deletes fail
  silently, the purge stamps `photosPurgedAt` anyway, and
  `generateInspectionPDF()` then refuses to produce a report for an inspection
  whose photos are still sitting in the bucket.
- **`account_members` has no write policy, deliberately, not even for the
  account owner.** A membership row decides *whose data a login sees*, so the
  obvious insert policy — "an owner may add members to their own account" —
  also lets any account name **someone else** as its member. That victim's
  `current_account_id()` flips to the attacker's account on their next
  request: their own rows vanish behind RLS and everything they save lands in
  the attacker's account, stamped as the attacker's data. Membership is
  granted from the SQL editor. Do not add a settings screen for it without
  solving that first.
- **An unrecognised role restricts, it never promotes.** `fetchAccessRole()`
  falls to the staff profile for a role name this build does not know, and
  `readCachedRole()` rejects one outright. A role that exists on the server
  and not in this file is a *newer* one, and new roles are added to take
  rights away.

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
  Shadows count: they are `rgba()`, so they are tokens too (`--shadow-1`,
  `--shadow-2`, `--shadow-lg`, `--shadow-up`).
  The same rule applies to the PDFs, where the token block is `MODERNIST` —
  see `reports/CLAUDE.md`.
- **`color-scheme` on both token blocks.** One line each, and it is what makes
  the browser's own widgets follow the theme: the select popup, the date picker,
  scrollbars, autofilled fields. Drop it and the date picker is not merely
  light, it is unreadable — Chrome draws dark text into it on the assumption
  the field is light.
- **`beforeprint` forcing light.** Browsers drop background colours when
  printing but keep text colours, so printing in dark mode puts `#ececea` on
  white paper — a page that reads as blank. The Print button is a real feature
  here, and this also covers Ctrl+P, which the button does not. It swaps the
  attribute rather than duplicating the palette into `@media print`, so there
  is no third copy to keep in step.

## Interface

- **`setSheetOpen()` is the only way a sheet opens or closes.** Setting a
  sheet's `style.display` directly still shows it, which is why it is
  tempting — and leaves `#main-app` interactive behind it, the scroll
  unlocked, focus stranded, and a history entry that makes the next Back
  press appear to do nothing. `ui-shell.test.mjs` covers the inert/lock and
  Back behaviour.
- **A new inspection's draft survives its sheet closing; an edit does not.**
  Closing an edit discards it, as Cancel always did. Closing a *new* one keeps
  its notes and photos (`data-keeps-draft`, `inspDraftTouched`) until it is
  saved or discarded, because photos taken on site are the costliest thing in
  the app to lose to a stray tap. `startInspectionFor()` and `editInspection()`
  never overwrite a draft someone has started without asking.
- **`.btn.page-cta{display:none}` and `.icon-btn.sidebar-close` carry two
  classes on purpose.** `.btn` and `.icon-btn` set `display` too and come later
  in the sheet; with one class the later rule wins, every page's primary
  button shows at once and the desktop page overflows sideways. It happened
  during the redesign.
- **Buttons inside a clickable row call `event.stopPropagation()` first.**
  Without it the row's own click runs too, and "PDF" also opens the editor.
- **No `Intl` / `toLocale*()` on the startup path.** The first Intl date format
  in a page loads the browser's locale data: 63ms at a mid-range phone's CPU
  speed, measured, for the date beside the page title. `updateTodayLabel()`
  and `formatClockTime()` build their strings by hand for this reason.
- **A page's sync banner is hidden while it has nothing to say** (`.sync-idle`
  — online, nothing waiting, nothing failing). The top-bar pill carries the
  "Synced" state. A banner that is missing when everything is synced is
  working, not broken.

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
