# CLAUDE.md — ProManage NZ

Guidance for Claude Code working in this repository.

<!-- Kept deliberately short: this file loads into every session in full.
     File-specific detail lives in .claude/rules/ and per-directory CLAUDE.md
     files, which load only when the matching files are read. Before adding
     anything here, ask whether it belongs in one of those instead.
     Do NOT use `@path` imports — they load eagerly and save nothing. -->

## What this is

A property-management app for a Christchurch, NZ property manager. An
**offline-first PWA in essentially one file**: every feature module lives in
`index.html` (~7k lines), with only the PDF generators split out into
`reports/pdf-reports.js` — and that split was made to stop them blocking the
first paint, not to tidy anything up. Backed by Supabase (Postgres + Auth +
private Storage) and IndexedDB for local state.

**There is no build step and no package.json.** You edit `index.html` directly
and open it in a browser. There *is* a test suite, but it runs against the real
page in a real browser rather than importing modules. Third-party libraries are
vendored into `vendor/` rather than pulled from a CDN, so the app works with no
signal and does not hand a third party a request on every page load.

## Non-negotiables

The full reasoning for each lives in the rule file named beside it. These
one-liners are here because they are the ones whose violation is **silent and
expensive**, and because grepping `index.html` — which is how you will usually
work in a 7k-line file — does not trigger the lazy-loaded rules.

- **`authHeader()` returns `null` with no session.** Never fall back to
  `CONFIG.SUPABASE_KEY`. It authenticates as `anon`, RLS matches nothing, and
  PostgREST reports that as `200 []` — indistinguishable from an empty table.
  This wiped the app's own local database once. Every backend call gets an
  `if(!token)` guard. → `app-invariants.md`
- **An empty remote list never triggers the delete pass** in `pullAndMerge()`,
  and **only an empty page ends pagination** in `fetchRemoteTablePaged()`. Both
  guards exist so a permission failure cannot be read as "the server is empty".
  → `app-invariants.md`
- **`escapeJsAttr` inside inline handlers, `escapeAttr` everywhere else.** Not
  interchangeable: an event-handler attribute is decoded twice. → `app-invariants.md`
- **`escapeHtml` on every interpolated value** in a list renderer, including the
  boring ones — ids, numbers, dates. → `app-invariants.md`
- **Archive verification re-runs at purge time**, not just at archive time.
  Purge is the only code that deletes photos from Storage on purpose, and every
  failure path must resolve to *keep the photos*. → `app-invariants.md`
- **`let sb = null` and a try/catch, never bare `const`,** for anything at the
  top level whose initialiser can throw. A failed `const` takes the whole app
  down and reports the wrong cause. → `app-conventions.md`
- **Every `fetch` branch in `sw.js` resolves to a `Response`.** `respondWith()`
  on `undefined` fails the request silently. → `service-worker.md`
- **Touching a shell file means bumping `CACHE_NAME`** in `sw.js`. → `service-worker.md`
- **Colours live in the token blocks, never in a rule** — `:root` for the app,
  `MODERNIST` for the PDFs. Tests fail on a stray hex. → `app-invariants.md`, `reports/CLAUDE.md`
- **`ACCESS_PROFILES` hides pages; RLS is what stops requests.** The two halves
  are written separately and both are required. The one client rule that is
  *not* cosmetic is the delete guard: PostgREST answers a refused DELETE with
  `204`. → `app-invariants.md`, `supabase/CLAUDE.md`

## Verify before you push

Run all three. CI runs exactly these:

```sh
node scripts/check-app.mjs      # static checks, no dependencies
node scripts/smoke-test.mjs     # boots the app in a real browser
node scripts/test.mjs           # the test suite
```

`smoke-test.mjs` needs Playwright, installed without writing a package.json:

```sh
npm install --no-save playwright && npx playwright install chromium
```

None of this replaces using the thing. Open `index.html` in a browser and
exercise the affected module both online **and** offline (DevTools → Network →
Offline).

## Where the detail lives

Read the relevant file **before** editing, not after. The `.claude/rules/`
files auto-load when you `Read` a matching file, but a `Grep` will not trigger
them, and they are not restored after `/compact` — so open them yourself when
you are working from search results.

| Working on | Read |
| --- | --- |
| `index.html` — orientation, file order, loading, theme, backup vs archive | `.claude/rules/app-architecture.md` |
| `index.html` — adding a module, the 7 registration points, top-level code | `.claude/rules/app-conventions.md` |
| `index.html` — what not to change and why | `.claude/rules/app-invariants.md` |
| Two logins, one account — profiles, roles, adding or removing staff | `supabase/CLAUDE.md` |
| `sw.js` | `.claude/rules/service-worker.md` |
| `reports/pdf-reports.js` — the `MODERNIST` tokens, jsPDF's silent failures | `reports/CLAUDE.md` |
| `supabase/schema.sql`, RLS, the project itself | `supabase/CLAUDE.md` |
| `scripts/` — what each check asserts, writing a test | `scripts/CLAUDE.md` |
| Known bugs, quota projections, the backup gap | `docs/REVIEW-2026-08.md` |
| Measured boot/sync latency, the file-splitting recommendation | `docs/REVIEW-2026-08-quality.md` |

## Repo hygiene

**This repo is the deploy root.** GitHub Pages serves every committed file
immediately, with no build step in between, and directories without an index
are listable. Never commit real owner/tenant data, generated statements, or
PDFs — see `.gitignore`.

## Working agreements

- **No line numbers in documentation.** Every one this file used to carry had
  drifted, by between 111 and 885 lines, and a stale number is worse than none
  because it reads as authoritative. Regenerate instead:
  `grep -n "^\s*\(async \)\?function \|^const \|^let \|^/\* =" index.html`
- **Splitting a file here is a performance decision, not a housekeeping one.**
  The duplication is what makes this codebase expensive to change, and
  scattering it across more files does not reduce it. Read the file-splitting
  section of `docs/REVIEW-2026-08-quality.md` before moving anything else out,
  and note that ES modules would break every test.
- **Prefer facts that cannot be derived from the code.** Directory listings,
  line counts and dependency lists go stale and are one `ls` away; pitfalls,
  incident history and rationale are not.
