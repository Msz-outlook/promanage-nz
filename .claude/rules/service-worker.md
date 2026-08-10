---
paths:
  - "sw.js"
---

# `sw.js` — things not to "simplify"

- **Every branch of a `fetch` handler resolving to a `Response`.**
  `event.respondWith()` on a promise that resolves to `undefined` fails the
  request outright, and for a `<script src>` that is silent — the library
  simply never loads. `cacheFirstRevalidate` did exactly that for a shell file
  that was neither cached nor reachable (`.catch(() => cached)` with nothing
  cached), which is what made "Cannot access 'sb' before initialization"
  recur rather than clear on reload. A 504 you can see beats an `undefined`
  you cannot.
- **The 3s deadline on the navigation fetch.** Network-first with no timeout is
  not the same as network-first: "unreachable" rejects, "answering very slowly"
  does not, and the second one hung a cold launch on a blank page with a
  working shell sitting in the cache.

## Changing the shell

`SHELL_FILES` must list every vendored library and every lazily-fetched
`reports/` file — including the ones that are *not* `<script src>` tags.
Pre-caching a file and blocking the first paint on it are different things:
heic2any, jsPDF, jspdf-autotable and `reports/pdf-reports.js` are fetched on
demand but stay pre-cached so they still work offline.

**Touching a shell file means bumping `CACHE_NAME`** (currently
`promanage-shell-v12`). Installed clients keep serving the old shell otherwise.
`node scripts/check-app.mjs --base origin/main` asserts this on pull requests,
and CI runs it that way.
