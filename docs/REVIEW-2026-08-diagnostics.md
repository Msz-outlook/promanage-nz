# ProManage NZ — failure-mode diagnosis and maintenance assessment

**Date:** 9 August 2026
**Scope:** what breaks this app and under what conditions, how often it needs
attention, an outside read on the project, and what still performs badly.
**Commit reviewed:** `f3d8b9b`
**Companion reviews:** [`REVIEW-2026-08.md`](REVIEW-2026-08.md) (backups, photo
sizing, quota) and [`REVIEW-2026-08-quality.md`](REVIEW-2026-08-quality.md)
(latency, escaping, duplication). This one does not repeat their findings
except to record which are still open.

Every failure below was reproduced in Chromium against the real page. The
harnesses are described under [Verification](#verification).

---

## Summary

The app is in good shape and the hardening work in the previous two reviews
holds up — I tried to break the boot path the way it broke in August and could
not. All three check scripts pass (164 test cases).

But there is **one failure that stops the app dead, and it fires in exactly the
situation the app was built for**: opening it offline, in a rental, more than
an hour after last using it online. The user is put behind a login gate they
cannot pass, after a 20-second wait, with an error message that blames the
wrong thing. Everything they need is in IndexedDB on the device.

| # | Failure | Trigger | Status |
| --- | --- | --- | --- |
| 1 | **Offline lockout on an expired session** | Cold start, offline, >58.5 min since last online use | **New — critical** |
| 2 | Photos ~5× larger than anything consumes them | Every inspection | Open (finding 6, 5 Aug) |
| 3 | One failed photo upload discards the whole batch | Weak signal mid-sync | Open (finding 4, 5 Aug) |
| 4 | Supabase pauses if the keep-alive stops | 60 days of repo inactivity, then 7 more | Latent, by design |
| 5 | Modules render twice on every cold boot | Every launch | New — minor |

Findings 1 and 3 share a root cause worth naming: **this codebase is
extensively tested against its own logic and barely tested against the
network.** The 164 cases assert on pure functions; the smoke test boots the app
online with no session. Neither can see finding 1, and neither would have
caught it.

---

## 1. Offline with an expired session locks the user out — critical

### What happens

The app is opened with no signal, using a stored session whose access token has
expired. Measured, on a cold start with the shell already cached:

```
+    41 ms  login gate (initial markup)
+ 20210 ms  login gate, with:
            "Sign-in did not respond. Another tab running this app can hold
             the auth lock — close other ProManage tabs and reload, or try a
             private window."
```

The app never opens. Sign-in cannot succeed — it needs the network. Every
property, tenant, inspection and statement is sitting in IndexedDB, unreachable
behind the gate.

**It does not recover when signal returns.** Firing the `online` event and
waiting eight seconds leaves the gate up: the `online` listener calls
`fullSyncNow()` and the six banner updaters, never `checkSession()`. The user
has to know to reload the page.

### Why

`checkSession()` treats any error from `getSession()` as "no session":

```js
const {data,error}=await withTimeout(sb.auth.getSession(),LOGIN_TIMEOUT_MS,'Session lookup did not respond');
if(error) throw error;          // → catch → showLoginGate()
```

Inside supabase-js, `__loadSession()` sees an expired token and tries to
refresh it over the network. Offline, that fails, and the relevant branch
returns `{data:{session:null}, error}` — it only falls back to the stored
session if the token has **not** actually expired yet.

Two constants in the vendored library set the boundary, and both were read out
of `vendor/supabase-js-2.111.0.umd.js` rather than assumed:

- **Expiry margin = 90 s** (`3 × 30 s` auto-refresh tick). The refresh path is
  taken from 90 seconds *before* nominal expiry.
- **Refresh retry deadline ≈ 25 s** — eight attempts with exponential backoff.

`LOGIN_TIMEOUT_MS` is 20 000, so `withTimeout` fires *first*, at 20.2 s. The
error it produces is "Sign-in did not respond", which `describeAuthFailure()`
matches on `/timed out|did not respond/i` and rewrites into the auth-lock
message. **That message is a misdiagnosis**, and an expensive one: it sends
someone standing in a rental to close tabs and open a private window — where
there is no local data at all.

Supabase's default access token lifetime is one hour. So:

> **The app works offline for 58.5 minutes after the last successful token
> refresh, and then locks the user out.**

### Measured boundary

| Stored token | Offline cold start | Time to decide |
| --- | --- | --- |
| expires in 120 s | **app opens** | 254 ms |
| expires in 30 s | locked out | 20 214 ms |
| expires in 5 s | locked out | 20 185 ms |
| expired 60 s ago | locked out | 20 177 ms |
| expired 1 h ago | locked out | 20 210 ms |
| *(control)* valid 1 h, offline | **app opens** | 244 ms |

The control matters: offline-first works perfectly when the token is in date.
This is specifically about staleness, not about being offline.

### Why it has not been noticed

Every routine that would mask it is present. `autoRefreshToken` keeps the token
fresh while a tab is open and online. The service worker serves the shell
offline. The test suite boots online. A device used daily on wifi refreshes its
token constantly and never sees this.

It appears when the app is **closed and reopened offline** — a phone in a
basement, an iPad woken up at a property, an installed PWA opened the morning
after. That is the primary use case.

### Recommendation

Three changes, smallest first. The first alone converts a lockout into a
working app.

1. **Do not gate the app on a network-dependent session check when offline.**
   In `checkSession()`, when `getSession()` errors *and* `navigator.onLine` is
   false, read the persisted session directly out of `localStorage`
   (`sb-<ref>-auth-token`) and, if it parses and carries the expected user, call
   `showApp()` + `enterApp(user.id)`. The app is already safe in this state:
   `authHeader()` returns the expired token, PostgREST rejects it, and
   `pullAndMerge()`'s empty-list guard means a rejected pull never triggers the
   delete pass. Offline work lands in IndexedDB and syncs when the token
   refreshes. Add a banner saying the session needs re-authenticating.

2. **Re-check the session when signal returns.** Add `checkSession()` to the
   `online` listener, guarded so it only runs while the login gate is showing.

3. **Stop misreporting the cause.** `describeAuthFailure()` should test
   `navigator.onLine` before the timeout branch and say "You are offline and
   this device's sign-in has expired" rather than blaming another tab. Separately,
   `LOGIN_TIMEOUT_MS` (20 s) is shorter than supabase-js's own retry deadline
   (~25 s), so the timeout wins every offline race — raise it above 25 s or
   fail fast on `!navigator.onLine`.

None of this weakens the rules in `CLAUDE.md`. `authHeader()` keeps returning
whatever the session holds and callers keep guarding on it; this only stops the
*UI* from treating "cannot reach the auth server" as "not signed in".

---

## 2. The photo pipeline — still the worst-performing part of the app

This is the answer to "what is not performing well". Nothing else measured
badly.

`captureCameraShot()` requests `width:{ideal:4032}` and encodes the full frame
at quality 0.92. `handlePhotoCapture()` (the file-picker path) does not resize
at all — it stores the camera roll original verbatim. Neither has changed since
the 5 August review flagged it.

Measured through both paths on the same source image:

| Stage | Size |
| --- | --- |
| Captured, 4032 × 3024, q0.92 | 647 KB (862 KB as base64 in IndexedDB) |
| **What the PDF actually consumes** (max edge 1600, q0.85) | **123 KB** |
| Proposed capture (max edge 1920, q0.85) | 164 KB |
| **Waste ratio** | **5.2×** |

*(That test image is a synthetic frame and compresses better than a real
photograph — the 5 Aug review measured real objects in the bucket at up to
2 884 KB. The **ratio** is the transferable number, since both figures come
from the same image through both paths.)*

At the real ~2.8 MB per photo, and 8 default areas × 4 photos:

| | Per year, 6 properties × 2 inspections |
| --- | --- |
| As built | ~1 075 MB — **over the 1 GB Free cap in year one** |
| At 1920 / q0.85 | ~190 MB |

Every one of those bytes is decoded, base64-encoded, written to IndexedDB,
uploaded, re-downloaded at report time, and then thrown away by
`normalizeToDataUrl`. 1920 px is deliberately above the report's 1600 px cap,
so **PDF output would be byte-for-byte unchanged**.

The crop-and-scale maths already exists and is proven, in
`FindingsReport.normalizeToDataUrl`. This is a shared-helper extraction, not
new code.

**What breaks when the cap is hit:** `uploadPhotoToStorage` throws, the push
returns `pushFailure`, and the inspection stays pending forever with its
base64 in IndexedDB — which then fills the device quota too. The banner does
report the reason after three attempts, so it degrades visibly rather than
silently. But it degrades.

---

## 3. One failed photo upload discards the entire batch

`uploadRecordPhotos()` maps `Promise.all` over areas and, inside that, over
photos. Measured on a record with 8 areas × 4 photos, with the 30th upload
rigged to fail:

```
photos in the record          : 32
peak uploads in flight        : 32        ← all of them, simultaneously
uploads that reached the wire : 32
outcome                       : REJECTED: Photo upload failed: 500
storage refs kept             : none — the function returns nothing
```

So: **31 photos uploaded successfully and every one of them is thrown away.**
`pushInspectionToBackend` catches the rejection, the record keeps its base64,
and the next retry re-sends all 32.

At ~2.8 MB each that is ~90 MB fired simultaneously from a phone on mobile
data, all-or-nothing, from inside a building with poor signal — which is both
the most likely place for it to fail and the most expensive place to retry.
Fixing finding 2 shrinks it to ~5 MB; fixing this one makes the failure
survivable.

**Recommendation** (unchanged from 5 Aug): upload sequentially, write the record
back to IndexedDB after each success so refs accumulate, tolerate per-photo
failure, and return what landed. The `photoSizes` bookkeeping already there
gives you the write-back point for free.

---

## 4. The keep-alive chain

Not a defect — a dependency worth stating plainly, because it is the one that
fails while nobody is looking:

```
no commits for 60 days
  → GitHub disables the scheduled keep-alive workflow (it emails first)
  → 7 more days with no sync
  → Supabase Free project auto-pauses
  → every sync fails; restorable from the dashboard within 90 days
```

`keep-alive.yml` documents this in its header, which is exactly right. The
consequence for maintenance is in the next section: **this repository cannot
sit idle for two months.**

Worth noting the app has no specific handling for a paused project — a paused
Supabase answers differently from a healthy one, and the sync banner will show
whatever HTTP status comes back rather than "the database is asleep, restore it
from the dashboard".

---

## 5. Modules render twice on every cold boot — minor

Instrumented on a cold start with a valid session, `renderAllModules()` is
called twice:

```
1. at HTMLDocument.<anonymous>  index.html:3465   (DOMContentLoaded)
2. at enterApp                  index.html:1592
```

`DOMContentLoaded` calls `checkSession()` without awaiting it, then calls
`renderAllModules()`; `checkSession()` → `enterApp()` calls it again. Every
module draws twice and the ~23 full-store IndexedDB reads happen twice.

At six properties that is roughly 23 ms of waste — immaterial, and I would not
touch it on performance grounds alone. It is worth knowing about because it
sits directly against the intent of the 7 August work, which was specifically
about not redrawing modules that nobody asked for. The `DOMContentLoaded` call
exists to draw the app for a signed-out user; scoping it to that case (or
letting `checkSession()` own it in both branches) is a two-line change.

---

## What no longer breaks

Credit where it is due — I went looking for these specifically and could not
reproduce any of them:

- **A vendored library failing to load.** `let sb = null` + try/catch holds.
  The app boots, shows a real message, offers a shell reset, and
  `diagnoseBackendInit()` distinguishes the three causes by asking the network.
  This is better than most production apps do.
- **A second tab during a `DB_VERSION` bump.** `onblocked` rejects with an
  actionable message and `onversionchange` releases the old connection. It ends
  with an app that renders nothing rather than a promise that never settles —
  a fair trade, and visible.
- **A `fetch` handler branch resolving to `undefined`.** Every path in `sw.js`
  returns a `Response`, including the 504.
- **A cold launch hanging on a slow network.** The 3 s navigation deadline works.
- **HTML/JS injection through list renderers**, and **a record missing
  `createdAt` blanking a page.** Both fixed and pinned by tests.
- **Invoice/statement number collisions.** The unique indexes are in
  `schema.sql` §8 and `pushInvoiceToBackend` re-mints once on a 409.
- **Float drift in money.** `roundMoney` is applied at the boundaries.

---

## How often does this need maintaining?

The honest answer is that it needs **small, regular attention rather than
large, occasional attention** — and that most of the schedule is driven by
things outside the code.

### Non-negotiable, because something external expires

| Cadence | Task | What happens if skipped |
| --- | --- | --- |
| **Every ~6 weeks** | Push *any* commit, or manually run the keep-alive workflow from the Actions tab | GitHub disables the schedule at 60 days; Supabase pauses 7 days later |
| **Monthly** | Run the in-app backup export (with photos quarterly) and put the file somewhere that is not this device | The Free plan has no automated backups. This export is the only copy |
| **Monthly** | Glance at the Archive card's storage headroom | Silent approach to the 1 GB cap; uploads start failing |
| **Quarterly** | Re-verify the NZ compliance copy and update `LAW_UPDATES_LAST_VERIFIED` (currently 21 Jul 2026) | The Healthy Homes and RTA text is static and dates quietly. This is the only content in the app a user could act on wrongly |
| **Quarterly** | Re-check Supabase advisors (`get_advisors`), and whether leaked-password protection is still Pro-gated | Documented open item |

### Driven by the browser, not by you

| Cadence | Task |
| --- | --- |
| **Twice a year** | Open the app in current Chrome *and* Safari/iOS and exercise one inspection end to end. `showDirectoryPicker` is Chrome/Edge desktop only, and Safari evicts script-writable storage after 7 days of no interaction unless the PWA is installed to the home screen — worth confirming the install path still works |
| **Twice a year** | Check the four vendored libraries for security advisories. Do not upgrade on a schedule; upgrade on a reason. If one moves, bump `CACHE_NAME` and re-run all three scripts |

### Driven by use

- **Per change:** the three scripts. They are fast and they have caught real
  regressions. Keep working through pull requests rather than pushing to `main`
  — the `CACHE_NAME` bump check only runs with `--base`, which CI supplies
  only on a `pull_request`.
- **Realistic budget:** roughly **half a day a quarter** for the routine items
  above, plus whatever features you want. That is genuinely low, and it is low
  *because* of the no-build-step choice — there is no dependency treadmill.

The thing that would change this picture is the Free plan. Findings 2 and 4 and
the entire monthly-backup ritual exist to work around it. Pro at $25/month
buys daily backups, no auto-pause, 100 GB of storage and the leaked-password
protection — and deletes three recurring chores. At the point where this app
holds a year of statements for six properties, that is the better trade.

---

## What someone experienced would say about this project

Asked directly, so answered directly.

**The first reaction would be surprise, then respect.** One 7 000-line HTML
file with no build step and vendored dependencies reads, at a glance, like
something that got away from its author. Ten minutes in `CLAUDE.md` and the two
review documents changes that read completely. This is not an accident that
grew; it is a set of deliberate constraints with the reasoning written down.

**What they would praise, specifically:**

- **The "things not to simplify" section of `CLAUDE.md` is the best artefact in
  the repository.** Most codebases lose this knowledge entirely — the empty-list
  guard before the delete pass, the `escapeJsAttr` ordering, the
  `PDF_ENGINE_FILES` sequencing, `verifyArchivedInspection` re-running at purge
  time. Each is a rule that looks redundant and is not, and each has the
  incident that produced it recorded next to it. That is senior work.
- **Failure modes are treated as first-class.** `let sb = null`, the 504 in the
  service worker, `authHeader()` returning null, `backendInitError`. Someone
  has thought hard about what a half-loaded app does to a user.
- **The tests test the real page, not a copy**, and the reasoning for why the
  runner is browser-based is written down. The decision to refuse to run if the
  page throws while booting — rather than reporting a suite of hoisted,
  meaningless passes — is a detail most test harnesses get wrong.
- **The deliberate refusal to over-engineer.** Not paginating a card that will
  show six rows. Not adopting a bundler. Those are correct calls and they are
  argued, not assumed.

**What they would push back on:**

- **The duplication is now the dominant maintenance cost, and it has been
  recommended twice without being done.** Still there today: **274 lines across
  seven `pushXToBackend` functions, 152 across seven `syncPendingX`, and six
  `updateXSyncBanner` wrappers.** The 7 August review called this out, proposed
  the exact shape of the fix (`mapRemoteX()` already exists as the inverse), and
  ordered it correctly — lift the property-delete 409 handling out first. The
  argument for doing it now rather than later is finding 3: a change to the
  upload path has to be made in one place and *reasoned about* in seven.
- **"No build step" is being conflated with "no tooling".** There is no type
  checking and no linting, and the escaping bugs of the last review were
  invisible to tooling because there was none. A `// @ts-check` comment plus
  JSDoc on the ~30 functions that cross module boundaries costs no build step
  and no runtime bytes, and it is checkable in CI with one `npx tsc` line. That
  is the cheapest quality win available here.
- **The bus factor is one, and the documentation is the mitigation.** That is
  the right mitigation and it is unusually well executed — but `CLAUDE.md` is
  29 KB of prose that has already been wrong once (the line numbers, which is
  why they were deleted). It needs the same skepticism as the code.
- **Testing stops at the network boundary**, which is where finding 1 lives.
  164 cases and not one of them can express "offline, with a stale session". A
  small number of Playwright scenario tests — offline cold start, expired
  token, upload failing mid-batch — would cover the failures that actually
  reach the user. The harness to write them already exists; this review used it.
- **Email Triage is still 263 shipped, disabled, mock-data lines.** Third time
  of asking: connect a mailbox or delete it.

**The overall verdict** would be that the architecture is right for the
constraints, the engineering discipline is well above what a single-user
internal tool usually gets, and the risk is not the file size — it is that the
duplication and the untested network boundary are both compounding, and both
have now been identified more than once without being closed.

---

## Verification

All three scripts pass at `f3d8b9b`:

```sh
node scripts/check-app.mjs      # all checks passed
node scripts/smoke-test.mjs     # smoke test passed
node scripts/test.mjs           # 164 passed
```

Findings 1, 3 and 5 were reproduced with throwaway Playwright harnesses built
on `scripts/lib/harness.mjs`:

- **Finding 1** — load the app once online so the shell caches, write a
  session into `localStorage` under `sb-<projectRef>-auth-token` with
  `expires_at` in the past, `context.setOffline(true)`, reload, and poll
  `#login-gate` / `#main-app` visibility over 45 s. The boundary table came
  from sweeping `expires_at` across ±120 s. Recovery was tested by clearing
  offline and dispatching `online`.
- **Finding 3** — replace `window.uploadPhotoToStorage` with a stub that counts
  concurrent calls and throws on the 30th, then call `uploadRecordPhotos()` on
  a 32-photo record and inspect what comes back.
- **Finding 5** — wrap `window.renderAllModules` in an init script and record
  a stack frame per call across one cold boot.

**These are worth adding to `scripts/tests/` as real cases**, particularly
finding 1's — it is the kind of regression that reappears the moment someone
touches `checkSession()`, and nothing currently in the suite would notice.

### Suggested order of work

| Priority | Work | Addresses |
| --- | --- | --- |
| 1 | Offline session fallback + `online` re-check + honest error text | 1 |
| 2 | Downscale at capture (1920 / q0.85), shared with `normalizeToDataUrl` | 2 |
| 3 | Sequential upload with per-photo write-back | 3 |
| 4 | Playwright scenario tests for all three of the above | — |
| 5 | Collapse `pushXToBackend` / `syncPendingX` / the banner wrappers | maintainability |
| 6 | `// @ts-check` + JSDoc on cross-module functions | maintainability |

Nothing in this review argues for a bundler, ES modules, or splitting
`index.html` further. The 7 August review settled those, and nothing found here
changes the conclusion.
