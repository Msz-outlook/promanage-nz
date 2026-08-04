# CLAUDE.md — ProManage NZ

Guidance for Claude Code working in this repository.

## What this is

A property-management app for a Christchurch, NZ property manager. It is a
**single-file offline-first PWA**: essentially all of the app lives in
`index.html` (~6.2k lines), backed by Supabase (Postgres + Auth + private
Storage) and IndexedDB for local state.

**There is no build step, no package.json, no test suite.** You edit
`index.html` directly and open it in a browser. Third-party libraries are
vendored into `vendor/` rather than pulled from a CDN, so the app works with no
signal and does not hand a third party a request on every page load.

## Files

| Path | Lines | What it is |
| --- | --- | --- |
| `index.html` | 6191 | The whole app — markup, CSS, PDF report modules, and every feature module |
| `supabase/schema.sql` | 567 | Idempotent schema: `updated_at` triggers, ownership columns, RLS, FKs, indexes, activity-log retention. Safe to re-run |
| `sw.js` | 126 | Service worker. App-shell cache (`CACHE_NAME = 'promanage-shell-v2'`), navigation falls back to cached `index.html` |
| `vendor/` | — | supabase-js 2.111.0, jsPDF 2.5.2, jspdf-autotable 3.8.2, heic2any 0.0.4 |
| `manifest.json` | — | PWA manifest |

**This repo is the deploy root.** GitHub Pages serves every committed file, and
directories without an index are listable. Never commit real owner/tenant data,
generated statements, or PDFs — see `.gitignore`.

## Map of `index.html`

Line numbers are accurate as of the current commit and **will drift with every
edit**. Regenerate rather than trusting them blindly:

```sh
grep -n "^\s*\(async \)\?function \|^const \|^let \|^/\* =" index.html
```

### Head and PDF report modules (lines 1–1221)

| Line | Item |
| --- | --- |
| 174 | `</head>` — all CSS is inline above it |
| 183–186 | Vendored `<script>` tags (supabase-js, jsPDF, autotable, heic2any) |
| 224–627 | `FindingsReport` — inspection report PDF, ends `global.FindingsReport` at 627 |
| 658–913 | `InvoiceReport` — invoice PDF, ends `global.InvoiceReport` at 913 |
| 949–1220 | `StatementReport` — owner statement PDF, ends `global.StatementReport` at 1220 |

Each is an IIFE taking `global`, depends only on the three globals loaded above
it, and exposes a single `generate(data, options)`.

### App shell, config, auth (1891–2084)

| Line | Function |
| --- | --- |
| 1894 | `nav(id, el, fromPopState)` — page switch; **calls the per-page render** |
| 1920 | `toggleSidebar(force)` |
| 1950 | `CONFIG` — Supabase URL + publishable key + bucket |
| 1980 | `BUSINESS_INFO` — printed on every invoice/statement PDF |
| 2002 | `LAW_UPDATES_LAST_VERIFIED` — static NZ compliance content date |
| 2012 | `checkSession()` |
| 2031 | `doLogin()` |
| 2064 | `doLogout()` |

### IndexedDB + account isolation (2084–2235)

| Line | Function |
| --- | --- |
| 2089 | `openDB()` — `promanageDB`, `DB_VERSION = 8`, 8 object stores |
| 2125–2152 | `dbPut` / `dbGetAll` / `dbDelete` / `dbClear` |
| 2198 | `enforceLocalDataOwner(userId)` — wipes local stores when a different account signs in |
| 2211 | `countUnsyncedRecords()` |
| 2231 | `resolvePropertyAddress(properties)` |

### Sync engine (2236–2615)

| Line | Function |
| --- | --- |
| 2363 | `fetchRemoteTablePaged(remoteTable, token, opts)` |
| 2423 | `pullAndMerge(storeName, remoteTable, mapRemoteToLocal, options)` |
| 2505–2552 | `mapRemote*` row mappers (property, tenant, maintenance, inspection, invoice, activity log, statement) |
| 2565 | `pullAllAndMerge(options)` — pulls all tables, then re-renders every module |
| 2594 | `fullSyncNow()` — push then pull; the **only** place that tells the user they are offline |

### Activity log (2617–2855)

| Line | Function |
| --- | --- |
| 2645 | `activityLogCutoffISO()` |
| 2654 / 2674 / 2702 | `pruneLocalActivityLog` / `pruneRemoteActivityLog` / `pruneActivityLogIfDue` |
| 2723 | `logActivity(entity, action, detail)` |
| 2794 | `renderActivityLog()` |

### Pagination (2741–2792)

| Line | Function |
| --- | --- |
| 2754 | `getListPage(key, all)` |
| 2765 | `renderPaginationControls(key, totalItems)` |
| 2779 | `LIST_RENDERERS` |

### Inspections (1927, 2857–3512)

| Line | Function |
| --- | --- |
| 2868 | `escapeHtml(str)` — used by every list renderer |
| 2873 | `addInspectionArea(name, opts)` |
| 2942–3040 | Camera modal: `openCameraModal` 2951, `captureCameraShot` 2992, `finishCameraCapture` 3028 |
| 3111 | `saveInspection()` |
| 3152 | `renderInspectionList()` |
| 3182 | `generateInspectionPDF(id, btn)` — `btn` is passed as `this` from the onclick |
| 3246–3310 | Photo refs: `extractStoragePath` 3246, `signStoragePaths` 3266, `resolvePhotoRefs` 3301 |
| 3323 | `deleteInspection(id)` |
| 3410 / 3452 / 3469 | `pushInspectionToBackend` / `syncPendingInspections` / `updateSyncBanner` |
| 3484–3485 | `online` / `offline` listeners |
| 3488 | `DOMContentLoaded` — first render of every module |

### Compliance (3515–3712)

| Line | Function |
| --- | --- |
| 3529–3544 | `HEALTHY_HOMES_ITEMS`, `REGULATORY_ITEMS_ALL`, `REGULATORY_ITEMS_ST` |
| 3551 | `getPropertyCompliance(p)` — fills defaults for records predating the feature |
| 3567 | `overallComplianceStatus(p)` |
| 3582 / 3609 | `openComplianceModal(id)` / `saveComplianceModal()` |
| 3635 | `renderComplianceLive()` |

### Properties (3714–3991)

| Line | Function |
| --- | --- |
| 3721 | `togglePropForm(show, record)` |
| 3757 | `saveProperty()` |
| 3787 | `renderPropertiesList()` |
| 3839 | `findPropertyLinks(propertyId)` — delete guard |
| 3860 | `deleteProperty(id)` |
| 3910 / 3949 / 3980 | `pushPropertyToBackend` / `syncPendingProperties` / `updatePropSyncBanner` |

### Tenants (3993–4210)

| Line | Function |
| --- | --- |
| 4011 | `toggleTenantForm(show, record)` |
| 4050 | `saveTenant()` |
| 4086 | `renderTenantsList()` |
| 4118 | `deleteTenant(id)` |
| 4148 / 4182 / 4199 | `pushTenantToBackend` / `syncPendingTenants` / `updateTenantSyncBanner` |

### Maintenance (4212–4416)

| Line | Function |
| --- | --- |
| 4227 | `toggleMaintForm(show, record)` |
| 4261 | `saveMaintenance()` |
| 4292 | `renderMaintenanceList()` |
| 4325 | `deleteMaintenance(id)` |
| 4355 / 4388 / 4405 | `pushMaintenanceToBackend` / `syncPendingMaintenance` / `updateMaintSyncBanner` |

### Email triage (4418–4678) — mock mode, no mailbox connected

| Line | Function |
| --- | --- |
| 4448 / 4472 | `MOCK_INBOX` / `fetchIncomingEmails()` |
| 4494 | `classifyEmail(email, properties)` |
| 4523 | `createMaintenanceFromTriage(triage)` |
| 4559 | `purgeDemoTriageData()` — console cleanup for demo-created records |
| 4586 | `processEmailTriageInbox()` |
| 4640 | `renderEmailTriageList()` |

Gated by `DEMO_EMAIL_TRIAGE_DEFAULT` (1964) / `demoEmailTriageEnabled()` (1965).
Off by default so the mock inbox cannot invent maintenance jobs on real data.

### Invoices (4680–5143)

| Line | Function |
| --- | --- |
| 4689 | `GST_RATE = 0.15` |
| 4772 | `recalcInvoiceTotals()` |
| 4792 | `nextInvoiceNumber()` |
| 4802 | `toggleInvoiceForm(show, record)` |
| 4850 | `saveInvoice()` |
| 4900 | `renderInvoicesList()` |
| 4931 | `deleteInvoice(id)` |
| 4961 / 4999 / 5016 | `pushInvoiceToBackend` / `syncPendingInvoices` / `updateInvoiceSyncBanner` |
| 5030 | `generateInvoicePDF(id)` |
| 5086 | `importInvoiceJSON(data)` |

### Statements (5145–5713)

| Line | Function |
| --- | --- |
| 5170 | `statementPropertyBlockHtml(blockId, optionsHtml, propBlock)` |
| 5210 / 5229 | `addStatementPropertyBlock` / `removeStatementPropertyBlock` |
| 5266 | `recalcStatementTotals()` |
| 5288 | `nextStatementNumber()` |
| **5300** | **`toggleStatementForm(show, record)`** |
| 5338 | `saveStatement()` |
| 5416 | `statementInDateRange(s, filter)` |
| 5471 | `renderStatementsList()` |
| 5529 | `deleteStatement(id)` |
| 5556 / 5594 / 5611 | `pushStatementToBackend` / `syncPendingStatements` / `updateStatementSyncBanner` |
| **5625** | **`generateStatementPDF(id)`** |
| 5690 | `importStatementJSON(data)` |

### Financials (5715–6061) — the agency's own books

| Line | Function |
| --- | --- |
| 5749 / 5755 | `isThirdPartyVendorLine(d)` / `isGstLine(d)` |
| 5769 | `classifyStatementExpenseLine(description)` |
| 5803 | `categorizeExpenseDescription(description)` |
| 5836 | `renderFinancials()` |

Derived live from Owner Statements — agency revenue is the management fee, not
the owner's rent.

### Dashboard (6063–6182)

| Line | Function |
| --- | --- |
| 6071 | `INSPECTION_INTERVAL_DAYS = 180` |
| 6082 | `lastInspectionByProperty(inspections)` |
| 6103 | `renderDashboard()` |
| 6184 | Service-worker registration |

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

1. `pages` (1892) and the nav markup
2. `nav()` (1894) — the per-page render call
3. `pullAllAndMerge()` (2565) — pull + re-render
4. `fullSyncNow()` (2594) — `syncPendingX()`
5. `doLogin()` (2031) — render + banner
6. `DOMContentLoaded` (3488) — render + banner
7. The `online` / `offline` listeners (3484–3485) — banner
8. `LIST_RENDERERS` (2779) if it paginates

Missing 5–7 is easy to overlook because `nav()` re-renders the page on
navigation, which masks the gap until a banner goes stale.

## Things not to "simplify"

- **Pagination + the delete guard** (see the comment at 2262). It looks
  redundant. It is not.
- **The private Storage bucket.** Photos are stored as `storage:<path>`
  references and signed at display time (`resolvePhotoRefs`, 3301). Paths are
  guessable from the address and inspection id, and a public bucket also allows
  listing. `storage:` is deliberately not loadable by `<img src>` so a missed
  resolver step fails loudly instead of leaking a link.
- **Server-side `updated_at`** (schema.sql §1). Conflict resolution compares
  `updated_at`; letting clients write it means the device with the fastest clock
  wins. It also makes the incremental pull cursor meaningful.
- **`escapeHtml` on every interpolated value** in list renderers. Addresses and
  tenant names are user input.
- **The vendored libraries.** Do not swap them back to CDN `<script>` tags.
- **Activity-log retention windows.** The pull filter and
  `pruneLocalActivityLog()` must use the same cutoff, or each undoes the other
  on every sync forever.
- **Passing the button into PDF generators.** `generateInspectionPDF(id, btn)`
  takes the element as `this` from the onclick; the global `event` is not
  reliable after the first `await`.

## Supabase

Project `ilxjyhnbnsufeomnkmsg` (`promanage-nz`, ap-southeast-2), org on the
**Free** plan.

- `CONFIG.SUPABASE_KEY` (1952) is the **publishable** key and is meant to be in
  this served file. A service-role key must never land here.
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

There is no test runner. At minimum, syntax-check the two inline script blocks:

```sh
python3 - <<'EOF'
import re
src = open('index.html', encoding='utf-8').read()
for i, b in enumerate(re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', src, re.S)):
    open(f'/tmp/block{i}.js', 'w', encoding='utf-8').write(b)
EOF
node --check /tmp/block0.js && node --check /tmp/block1.js
```

Then open `index.html` in a browser and exercise the affected module both online
and offline (DevTools → Network → Offline).

When bumping anything in `vendor/` or the app shell, update `SHELL_FILES` and
bump `CACHE_NAME` in `sw.js` — installed clients keep serving the old shell
otherwise.

## Notifying the user when a response finishes

A `Stop` hook (`.claude/settings.json` → `.claude/hooks/notify-stop.sh`) fires
a real OS notification when Claude Code runs on the user's own machine. It
cannot reach the user in a cloud/remote session — there is no local display
for `osascript`/`notify-send` to reach, and this project's network egress
policy blocks third-party push services (verified: `ntfy.sh` gets a 403
policy denial from the agent proxy). In a remote session, call the
`PushNotification` tool yourself at the end of a turn instead — it reaches
the user's terminal and, if Remote Control is linked, their phone.
