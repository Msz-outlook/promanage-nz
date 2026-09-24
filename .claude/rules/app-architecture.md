---
paths:
  - "index.html"
---

# The shape of `index.html`

Loaded when you read `index.html`. Companion files:
`.claude/rules/app-invariants.md` (what not to change) and
`.claude/rules/app-conventions.md` (how to add to it).

## Finding things

**No line numbers here on purpose.** Every one this file used to carry was
wrong — they had drifted by between 111 and 885 lines — and a stale number is
worse than none, because it reads as authoritative and sends you to the wrong
function. Regenerate instead:

```sh
grep -n "^\s*\(async \)\?function \|^const \|^let \|^/\* =" index.html
```

## Loading strategy — one blocking library, everything else on demand

All CSS is inline, above `</head>`. Below it there is exactly **one**
`<script src>`: supabase-js. Auth runs at boot and nothing is on screen until
it answers, so that one is load-bearing.

Everything else is fetched when first needed. Between them they were 76% of the
JavaScript this app used to block the first paint, for output that does not
exist until a button is clicked:

| Fetched by | What | Size |
| --- | --- | --- |
| `FindingsReport.loadHeic2Any()` | heic2any | 1.32 MB |
| `loadPdfEngine()` | jsPDF, jspdf-autotable, `reports/pdf-reports.js` | 438 KB |

First paint on a throttled 3G phone went from **11.8s to 2.8s**. All four files
stay in `SHELL_FILES`, so they are still pre-cached and still work offline —
pre-caching a file and blocking the first paint on it are different things.

**`index.html` has two inline script blocks: the theme block and the app
block.** `check-app.mjs` parses every block it finds, so adding another is
fine. The smoke test's "block 1 ran to completion" assertion means the *app*
block — the theme block is block 0.

## The theme block — in `<head>`, above everything

Twenty-odd lines resolving light/dark before the body paints. It is separate
from the app block for two reasons, both load-bearing:

- **It must run before the first paint.** Resolved from the app block, the
  first frame would be light and every cold launch in dark mode would flash
  white — for however long supabase-js takes to arrive.
- **It must survive the app block dying.** A throw at the top level of the app
  block abandons everything after it; a user who cannot read the screen is
  worse off than one looking at a half-wired app.

`applyTheme()` always stamps an explicit `light`/`dark` on `<html>` — never
`system`, which it resolves itself via `matchMedia`. That is what lets the
stylesheet carry **one** dark block keyed on `[data-theme="dark"]` instead of
also duplicating the palette inside a `prefers-color-scheme` media query.

Everything it exports is `THEME_*`-prefixed or theme-named on purpose. A
top-level `var` in a classic script creates a *non-configurable* window
property, so a later top-level `const` of the same name in the app block fails
to instantiate — a SyntaxError that takes the whole app down, not just the
theme. Incidental locals (`mq`) are inside an IIFE for exactly this reason.

Preference lives in `localStorage` (`promanage_theme`), not the IndexedDB
`settings` store: it is needed synchronously, before a paint, and `openDB()` is
async and has not run yet.

## The app block, in file order

| Section | What is worth knowing |
| --- | --- |
| App shell, config, auth | `nav()` switches page **and draws it**, keeps the tab bar in step (`syncTabBar`) and stamps the page id on `<body data-page>`. `CONFIG` holds the Supabase URL, publishable key and bucket. `BUSINESS_INFO` is printed on every invoice/statement PDF. `LAW_UPDATES_LAST_VERIFIED` dates the static NZ compliance copy |
| Access control | `ACCESS_PROFILES` — which pages, which stores sync, whether deletes are allowed. `establishAccessRole()` resolves it from `account_members` at every entry and caches it per user id; `applyAccessRole()` paints it onto the sidebar and the phone tab bar (`TAB_PRIORITY`). The whole section is presentation — the enforcement is RLS |
| Module registry, UI kit | `MODULE_RENDERERS` / `PAGE_MODULES`, then `noteLocalDataChange()`, `svgIcon()`, `showToast()`, the sheet system (`setSheetOpen()` and friends) and the sync pill — see "The interface" below |
| IndexedDB + account isolation | `openDB()` — `promanageDB`, `DB_VERSION = 9`, 9 stores (8 synced + `settings`). `enforceLocalDataOwner()` wipes local stores when a different account signs in |
| Sync engine | `fetchRemoteTablePaged` → `pullAndMerge` → `pullAllAndMerge` (concurrent pulls, then draws the visible page). `fullSyncNow()` pushes then pulls, and is the **only** place that tells the user they are offline. `mapRemoteX()` row mappers live here |
| Activity log | Pruned on a retention window at both ends — see `supabase/CLAUDE.md` |
| Pagination | `getListPage` / `renderPaginationControls` / `LIST_RENDERERS` |
| Inspections | `escapeHtml` is defined here and used by every list renderer. Camera modal, photo refs (`extractStoragePath` / `signStoragePaths` / `resolvePhotoRefs`), and `generateInspectionPDF(id, btn)` — `btn` arrives as `this` from the onclick |
| Compliance | `getPropertyCompliance()` fills defaults for records predating the feature |
| Properties | `findPropertyLinks()` is the delete guard; the database enforces it too |
| Tenants, Maintenance | The plain form of the module shape in `app-conventions.md` |
| Email triage | **Mock mode — no mailbox is connected.** Gated by `DEMO_EMAIL_TRIAGE_DEFAULT` / `demoEmailTriageEnabled()`, off by default so `MOCK_INBOX` cannot invent maintenance jobs on real data |
| Invoices | `GST_RATE = 0.15`, `nextInvoiceNumber()`, `importInvoiceJSON()` |
| Statements | Multi-property blocks, `nextStatementNumber()`, `importStatementJSON()` |
| Financials | The agency's own books, derived live from Owner Statements — revenue is the management fee, **not** the owner's rent |
| Backup / Archive | Two different jobs — see below |
| Dashboard | `INSPECTION_INTERVAL_DAYS = 180`. Service-worker registration is the **last top-level statement in the block**, which is why the smoke test asserting it proves the whole block ran |

## The interface

Redesigned in September 2026 around one rule: show what needs attention, and
put the action for it one tap away. The parts that are not obvious from the
markup:

- **The document scrolls, not an inner box.** The sidebar is `position:sticky`
  and the phone tab bar `position:fixed`. The old shell pinned `.app` to
  `100vh` and scrolled `.main`, which hid the last rows of every list under a
  phone's URL bar. `nav()` scrolls to the top on a page change for the same
  reason.
- **Two layouts, one breakpoint: 899px** (`MOBILE_NAV_QUERY`, and the matching
  media query). Wider: sidebar. Narrower: a tab bar with the first four pages
  the login can open (`TAB_PRIORITY`) plus "More", which opens the same
  sidebar element as a bottom sheet. A page without a tab lights up "More".
- **One primary action per page, always top right** — `.page-cta[data-for]`
  in the top bar, shown by `body[data-page]`. On a phone the same button is
  the floating action button above the tab bar.
- **Every create/edit form is a sheet** (`.sheet`, outside `#main-app`): a
  panel from the right on a wide screen, the whole screen on a phone.
  `setSheetOpen()` is the only thing that shows or hides one, because it owns
  everything that has to stay in step: `inert` on `#main-app`, the scroll
  lock, focus in and back out, one history entry so the system Back button
  closes the sheet, and the unsaved-changes question on Escape, Back or a
  backdrop tap. Each sheet's `[data-sheet-close]` button is how those three
  close it, so a module's own close logic always runs.
- **Sheets open over any page.** The dashboard opens a maintenance job, a
  tenancy or a checklist in place. `logActivity()` calls
  `noteLocalDataChange()`, which marks every page but the visible one stale
  and bumps `dataVersion`; a sheet that closes with a different `dataVersion`
  redraws the page behind it.
- **List rows open with one tap.** `tr.row-link` takes the click; a
  `<button class="row-title">` in its first cell gives the keyboard and a
  screen reader a real control. Anything else clickable in the row calls
  `event.stopPropagation()` first. Below 900px, `.rtable` rows become cards —
  the `c-title` / `c-sub` / `c-meta` (with `data-label`) / `c-badge` /
  `c-actions` classes on each cell decide where it lands.
- **Quiet when fine, visible when not.** The top-bar sync pill is the
  app-wide state (Synced / N to sync / Offline / Sync issue). A page's own
  sync banner is hidden (`.sync-idle`) until that page has something to say.
- **Toasts for success, dialogs for everything else.** `showToast()` /
  `savedToast()` confirm a save or delete; a failure, a refusal or anything
  that needs a decision stays an `alert()` / `confirm()`, and several tests
  rely on that.
- **Icons are an inline SVG sprite** at the top of `<body>`, used as
  `<svg class="icon"><use href="#i-…">` or `svgIcon('…')`. No emoji: they
  render differently on every platform and cannot follow the theme.

## Backup and Archive are not the same thing

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
