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
| App shell, config, auth | `nav()` switches page **and draws it**. `CONFIG` holds the Supabase URL, publishable key and bucket. `BUSINESS_INFO` is printed on every invoice/statement PDF. `LAW_UPDATES_LAST_VERIFIED` dates the static NZ compliance copy |
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
