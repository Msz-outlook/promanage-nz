# CLAUDE.md — ProManage NZ

Guidance for Claude Code working in this repository.

## What this is

A property-management app for a Christchurch, NZ property manager. It is a
**single-file offline-first PWA**: essentially all of the app lives in
`index.html` (~7k lines), backed by Supabase (Postgres + Auth + private
Storage) and IndexedDB for local state.

**There is no build step and no package.json.** You edit `index.html` directly
and open it in a browser. There is no test *runner* either, but the app is
driveable headlessly with Playwright and that is the only way to verify the
sync engine honestly — see "Verifying a change". Third-party libraries are
vendored into `vendor/` rather than pulled from a CDN, so the app works with no
signal and does not hand a third party a request on every page load.

## Files

| Path | Lines | What it is |
| --- | --- | --- |
| `index.html` | 6967 | The whole app — markup, CSS, PDF report modules, and every feature module |
| `supabase/schema.sql` | 567 | Idempotent schema: `updated_at` triggers, ownership columns, RLS, FKs, indexes, activity-log retention. Safe to re-run |
| `sw.js` | 126 | Service worker. App-shell cache (`CACHE_NAME = 'promanage-shell-v2'`), navigation falls back to cached `index.html` |
| `vendor/` | — | supabase-js 2.111.0, jsPDF 2.5.2, jspdf-autotable 3.8.2, heic2any 0.0.4 |
| `manifest.json` | — | PWA manifest |

**This repo is the deploy root.** GitHub Pages serves every committed file, and
directories without an index are listable. Never commit real owner/tenant data,
generated statements, or PDFs — see `.gitignore`.

## Map of `index.html`

Line numbers are approximate as of the current commit and **will drift with
every edit**. Section ranges especially. Regenerate rather than trusting them:

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

### App shell, config, auth (1936–2146)

| Line | Function |
| --- | --- |
| 1939 | `nav(id, el, fromPopState)` — page switch; **calls the per-page render** |
| 1965 | `toggleSidebar(force)` |
| 1995 | `CONFIG` — Supabase URL + publishable key + bucket |
| 2025 | `BUSINESS_INFO` — printed on every invoice/statement PDF |
| 2048 | `BUSINESS_INFO_DEFAULTS` / `resetBusinessInfo()` — undoes an imported JSON's overrides |
| 2062 | `LAW_UPDATES_LAST_VERIFIED` — static NZ compliance content date |
| 2072 | `checkSession()` |
| 2092 | `doLogin()` |
| 2126 | `doLogout()` |

### IndexedDB + account isolation (2148–2395)

| Line | Function |
| --- | --- |
| 2151 | `openDB()` — `promanageDB`, `DB_VERSION = 8`, 8 object stores |
| 2187–2214 | `dbPut` / `dbGetAll` / `dbDelete` / `dbClear` |
| 2236 | `readStore(store)` — **use this in renderers**, not `dbGetAll().catch(()=>[])` |
| 2284 | `confirmNoDuplicate(store, field, value, currentId, noun)` |
| 2298 | `newId(prefix)` — `crypto.randomUUID`, never `Date.now()` alone |
| 2313 | `dbGet(storeName, id)` — single record; avoids a full-store scan |
| 2358 | `enforceLocalDataOwner(userId)` — wipes local stores when a different account signs in |
| 2371 | `countUnsyncedRecords()` |
| 2391 | `resolvePropertyAddress(properties)` |

### Sync engine (2396–3050)

| Line | Function |
| --- | --- |
| 2523 | `fetchRemoteTablePaged(remoteTable, token, opts)` |
| 2583 | `pullAndMerge(storeName, remoteTable, mapRemoteToLocal, options)` |
| 2665–2712 | `mapRemote*` row mappers (property, tenant, maintenance, inspection, invoice, activity log, statement) |
| 2744 | `pullAllAndMerge(options)` — pulls all tables, then re-renders every module |
| 2779 | `fullSyncNow()` — session check → push → prune → pull. Guarded by `syncInFlight`; the **only** place that tells the user they are offline |
| 2827 | `markSyncSessionExpired()` / `clearSyncSessionExpired()` |

**The push path is shared, not per-entity.** These three replaced six
copy-pasted versions each:

| Line | Function |
| --- | --- |
| 2859 | `renderSyncBanner(suffix, store)` — one implementation behind all six `updateXSyncBanner()` one-liners; `SYNC_BANNERS` (2848) is the registry |
| 2916 | `describeRestError(res)` — pulls PostgREST's `message`/`hint`/`details` out of the body |
| 2932 | `pushViaRest(remoteTable, record, buildBody)` — DELETE/upsert; returns `{ok, deleted?, blocked?, sessionExpired?, status?, error?}` |
| 2982 | `syncPendingStore(store, pushFn, opts)` — the pending loop, with compare-and-set on `updatedAt` |

A `pushXToBackend` is now just a field map handed to `pushViaRest`.
`pushInspectionToBackend` (3800) is the one exception — it uploads photos first
and returns the swapped `storage:` refs as `patch`.

### Activity log (3052–3158)

| Line | Function |
| --- | --- |
| 3062 | `activityLogCutoffISO()` |
| 3071 / 3091 / 3119 | `pruneLocalActivityLog` / `pruneRemoteActivityLog` / `pruneActivityLogIfDue` |
| 3140 | `logActivity(entity, action, detail)` |
| 3275 | `renderActivityLog()` |

### Pagination and search (3160–3270)

Both keyed off the same list key (`properties`, `tenants`, `maintenance`,
`triage`, `inspections`, `invoices`, `statements`, `activity`).

| Line | Function |
| --- | --- |
| 3158 | `PAGINATION_CONFIG` — page size + pagination container id per key |
| 3179 | `SEARCH_FIELDS` — searchable fields per key; an entry may be a field name **or** a function, for values nested inside a record (statements keep the address in `properties[].propertyAddress`) |
| 3192 | `setListSearch(key, value)` — stores the query, resets to page 1, re-renders |
| 3201 | `applyListSearch(key, all)` — call this **before** `getListPage` so the page count describes the filtered set |
| 3215 | `renderSearchCount(key, shown, total)` |
| 3225 | `emptyListMessage(key, defaultMsg)` — resolves the three-way "no records / no matches / couldn't read the database" |
| 3235 | `getListPage(key, all)` |
| 3246 | `renderPaginationControls(key, totalItems)` |
| 3260 | `LIST_RENDERERS` |

The search input markup is a `.list-search` div immediately before each
`.table-outer`, with ids `search-<key>` and `search-count-<key>`.

### Inspections (1972, 3324–4460)

| Line | Function |
| --- | --- |
| 3335 | `escapeHtml(str)` — escapes quotes too, so it is safe in attributes; `escapeAttr` (3346) is an alias |
| 3351 | `addInspectionArea(name, opts)` |
| 3442–3530 | Camera modal: `openCameraModal` 3442, `captureCameraShot` 3483, `finishCameraCapture` 3519 |
| 3602 | `saveInspection()` |
| 3643 | `renderInspectionList()` |
| 3690 | `buildInspectionReport(insp, properties)` — shared by the PDF button and the archive |
| 3722 | `generateInspectionPDF(id, btn)` — `btn` is passed as `this` from the onclick |
| 3764–3830 | Photo refs: `extractStoragePath` 3764, `signStoragePaths` 3784, `resolvePhotoRefs` 3819 |
| 4252 | `deleteInspection(id)` |
| 3800 / 4429 / 4435 | `pushInspectionToBackend` / `syncPendingInspections` / `updateSyncBanner` |
| 4439–4441 | `online` / `offline` listeners |
| 4443 | `DOMContentLoaded` — **awaits `checkSession()`** before rendering, so a previous account's rows never paint |

### Compliance (4463–4660)

| Line | Function |
| --- | --- |
| 4489–4505 | `HEALTHY_HOMES_ITEMS`, `REGULATORY_ITEMS_ALL`, `REGULATORY_ITEMS_ST` |
| 4511 | `getPropertyCompliance(p)` — fills defaults for records predating the feature |
| 4527 | `overallComplianceStatus(p)` |
| 4542 / 4569 | `openComplianceModal(id)` / `saveComplianceModal()` |
| 4595 | `renderComplianceLive()` |

### Properties (4662–4830)

| Line | Function |
| --- | --- |
| 4682 | `togglePropForm(show, record)` |
| 4718 | `saveProperty()` |
| 4749 | `renderPropertiesList()` |
| 4803 | `findPropertyLinks(propertyId)` — delete guard |
| 4824 | `deleteProperty(id)` — the only delete with a 409 "blocked" path |
| 4874 / 4885 / 4901 | `pushPropertyToBackend` / `syncPendingProperties` / `updatePropSyncBanner` |

### Tenants (4903–5060)

| Line | Function |
| --- | --- |
| 4919 | `toggleTenantForm(show, record)` |
| 4958 | `saveTenant()` |
| 4994 | `renderTenantsList()` |
| 5028 | `deleteTenant(id)` |
| 5056 / 5066 / 5072 | `pushTenantToBackend` / `syncPendingTenants` / `updateTenantSyncBanner` |

### Maintenance (5070–5230)

| Line | Function |
| --- | --- |
| 5091 | `toggleMaintForm(show, record)` |
| 5125 | `saveMaintenance()` |
| 5156 | `renderMaintenanceList()` |
| 5191 | `deleteMaintenance(id)` |
| 5219 / 5229 / 5235 | `pushMaintenanceToBackend` / `syncPendingMaintenance` / `updateMaintSyncBanner` |

### Email triage (5240–5490) — mock mode, no mailbox connected

| Line | Function |
| --- | --- |
| 5268 / 5292 | `MOCK_INBOX` / `fetchIncomingEmails()` |
| 5314 | `classifyEmail(email, properties)` |
| 5343 | `createMaintenanceFromTriage(triage)` |
| 5379 | `purgeDemoTriageData()` — console cleanup for demo-created records |
| 5406 | `processEmailTriageInbox()` |
| 5460 | `renderEmailTriageList()` |

Gated by `DEMO_EMAIL_TRIAGE_DEFAULT` (2009) / `demoEmailTriageEnabled()` (2010).
Off by default so the mock inbox cannot invent maintenance jobs on real data.

### Invoices (5495–5960)

| Line | Function |
| --- | --- |
| 5511 | `GST_RATE = 0.15` |
| 5590 | `recalcInvoiceTotals()` |
| 5610 | `nextInvoiceNumber()` — only *suggests*; `saveInvoice` warns on a duplicate |
| 5620 | `toggleInvoiceForm(show, record)` |
| 5668 | `saveInvoice()` |
| 5719 | `renderInvoicesList()` |
| 5752 | `deleteInvoice(id)` |
| 5780 / 5790 / 5796 | `pushInvoiceToBackend` / `syncPendingInvoices` / `updateInvoiceSyncBanner` |
| 5804 | `generateInvoicePDF(id)` |
| 5860 | `importInvoiceJSON(data)` — **asks before applying `sender`/`bank`/`logo`** |

### Statements (5962–6530)

| Line | Function |
| --- | --- |
| 5975 | `statementPropertyBlockHtml(blockId, optionsHtml, propBlock)` |
| 6016 / 6035 | `addStatementPropertyBlock` / `removeStatementPropertyBlock` |
| 6072 | `recalcStatementTotals()` |
| 6094 | `nextStatementNumber()` |
| **6106** | **`toggleStatementForm(show, record)`** |
| 6144 | `saveStatement()` |
| 6222 | `statementInDateRange(s, filter)` |
| 6278 | `renderStatementsList()` — date-range filter **and** text search |
| 6341 | `deleteStatement(id)` — three branches; see "Things not to simplify" |
| 6377 / 6387 / 6393 | `pushStatementToBackend` / `syncPendingStatements` / `updateStatementSyncBanner` |
| **6401** | **`generateStatementPDF(id)`** |
| 6466 | `importStatementJSON(data)` |

### Financials (6532–6836) — the agency's own books

| Line | Function |
| --- | --- |
| 6525 / 6531 | `isThirdPartyVendorLine(d)` / `isGstLine(d)` |
| 6545 | `classifyStatementExpenseLine(description)` |
| 6579 | `categorizeExpenseDescription(description)` |
| 6612 | `renderFinancials()` |

Derived live from Owner Statements — agency revenue is the management fee, not
the owner's rent.

### Dashboard (6839–6960)

| Line | Function |
| --- | --- |
| 6847 | `INSPECTION_INTERVAL_DAYS = 180` |
| 6858 | `lastInspectionByProperty(inspections)` |
| 6879 | `renderDashboard()` |
| 6962 | Service-worker registration |

### Photo archive + data backup (3860–4250)

Photos are the only thing here that can exhaust the Supabase Free tier. Nothing
compresses them on the way in — the camera modal asks for 12MP and encodes at
JPEG 0.92 — so the plan is to move them off periodically rather than upgrade.

| Line | Function |
| --- | --- |
| 3866 | `ARCHIVED_REF_PREFIX` + `archivedRefFor` / `isArchivedRef` / `archivedRefPath` |
| 3892 | `crc32(bytes)` |
| 3898 | `buildZip(files)` — store-only ZIP, no vendored library (payload is JPEG/PDF, already compressed) |
| 3938 | `downloadBlob(blob, filename)` |
| 3952 | `collectInspectionPhotos(record)` — skips already-archived refs |
| 3983 | `buildPhotoArchive(records)` — photos **+ the illustrated findings PDF** + `manifest.json` |
| 4056 | `releaseArchivedPhotos(archived)` — deletes bucket objects, rewrites refs to `archived:`, marks the record unsynced so it re-pushes |
| 4089 | `runPhotoArchive(records, label)` — download first, release only on a second confirmation |
| 4148 | `archiveOldInspectionPhotos()` — the date-cutoff entry point |
| 4175 | `BACKUP_STORES` |
| 4177 | `exportAllData()` — whole-dataset JSON; aborts rather than emit a partial file |
| 4204 | `importBackupJSON(text)` — **additive**; existing records always win |

Photos never leave without the user seeing the zip first. `releaseArchivedPhotos`
is the only thing that deletes from Storage, and it runs only after an explicit
second confirmation.

## Conventions

**Every module follows the same offline-first shape.** When adding one, copy it:

- `toggleXForm(show, record)` — one form for create and edit
- `saveX()` — write to IndexedDB first, then sync in the background
- `renderXList()` — reads via `readStore`, escapes with `escapeHtml`, filters
  with `applyListSearch`, paginates via `getListPage`
- `deleteX(id)` — three branches, and all three matter:
  - synced + online → delete remotely, then `dbDelete` locally
  - synced + offline → `pendingDelete = true` **and `synced = false`**
  - never synced → `dbDelete` locally, no request
- `pushXToBackend(record)` — a field map handed to `pushViaRest`, nothing more
- `syncPendingX()` — `await syncPendingStore(store, pushFn)` then render + banner
- `updateXSyncBanner()` — `return renderSyncBanner(suffix, store)`
- `mapRemoteX(row)` + a `pullAndMerge(...)` line in `pullAllAndMerge()`

**A new module has to be registered in all of these places**, or it will look
fine on its own page and be stale everywhere else:

1. `pages` (1937) and the nav markup
2. `nav()` (1939) — the per-page render call
3. `pullAllAndMerge()` (2744) — pull + re-render
4. `fullSyncNow()` (2779) — `syncPendingX()`
5. `doLogin()` (2092) — render + banner
6. `DOMContentLoaded` (4443) — render + banner
7. The `online` / `offline` listeners — banner
8. `SYNC_BANNERS` (2848) if it has a sync banner
9. `PAGINATION_CONFIG` (3158), `SEARCH_FIELDS` (3179) and `LIST_RENDERERS`
   (3260) if it paginates
10. `BACKUP_STORES` (4175) — otherwise the module is silently absent from every
    backup, which is the worst place to discover a gap

Missing 5–7 is easy to overlook because `nav()` re-renders the page on
navigation, which masks the gap until a banner goes stale.

## Things not to "simplify"

- **`authHeader()` returning `null`.** It must never fall back to
  `CONFIG.SUPABASE_KEY`. Every RLS policy is granted `to authenticated`, so an
  anon-key read is *filtered, not rejected* — PostgREST answers `200 []`. That
  is indistinguishable from "the account genuinely has no rows", and
  `pullAndMerge`'s delete pass acts on it by deleting every synced record on
  the device. Returning null turns it into a 401, which every caller already
  treats as "don't trust this list". The empty-remote guard in `pullAndMerge`
  is the second layer of the same defence — keep both.
- **`syncPendingStore`'s re-read before marking `synced`.** The record is
  snapshotted before a network call that takes seconds. Writing the snapshot
  back afterwards overwrites any edit saved in that window *and* marks it
  synced, so it is lost locally and never pushed. Compare `updatedAt` first.
- **The three branches in every `deleteX`.** A synced record deleted while
  offline needs `synced = false` as well as `pendingDelete = true`, or
  `syncPendingStore` never picks it up, the row lives on server-side, and the
  next pull merges it back — resurrecting something the user deleted.
- **Pagination + the delete guard** (see the comment at 2422). It looks
  redundant. It is not.
- **`archived:` photo references.** Deliberately not resolvable by
  `extractStoragePath`, for the same reason as `storage:` — a photo the user
  archived on purpose must never be indistinguishable from a broken one.
- **The findings PDF baked into the photo archive.** Once photos are released
  from Storage, regenerating the report produces the same text with no images.
  If it isn't captured while they're reachable, the illustrated version of that
  inspection stops existing.
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

- `CONFIG.SUPABASE_KEY` (1997) is the **publishable** key and is meant to be in
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

**For anything touching the sync engine, that is not enough.** The failure modes
that matter there are invisible in normal use — they need an expired session, a
mid-flight edit, or a rejected row. Playwright is available and Chromium is
preinstalled (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; do **not** run
`playwright install`). Serve the directory and drive the real page:

```sh
python3 -m http.server 8123 --bind 127.0.0.1 &
# then page.evaluate(...) against http://127.0.0.1:8123/index.html
```

Every internal function is reachable from `page.evaluate`, so the engine can be
tested directly without a Supabase session — pass a fake `pushFn` to
`syncPendingStore`, override `navigator.onLine`, stub `openDB` to reject. The
cases worth keeping green:

| Behaviour | Expectation |
| --- | --- |
| `authHeader()` with no session | returns `null`, **never** `CONFIG.SUPABASE_KEY` |
| Edit saved while a push is in flight | edit survives and stays pending |
| Push rejected 3× | `syncAttempts` 3, `lastSyncError` set, still pending |
| Synced statement deleted offline | `pendingDelete: true` **and** `synced: false` |
| Row with `createdAt: null` | list still renders; it used to blank entirely |
| Property address `<img src=x onerror=…>` | renders as text on Compliance, Invoices, Statements |
| `openDB` rejecting | banner + "could not read" message, not "no records yet" |
| `buildZip` output | validates against `python3 -m zipfile` / `unzip -t` |

When bumping anything in `vendor/` or the app shell, update `SHELL_FILES` and
bump `CACHE_NAME` in `sw.js` — installed clients keep serving the old shell
otherwise.
