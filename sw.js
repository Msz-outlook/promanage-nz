// ProManage NZ — service worker
//
// Makes the app itself loadable with zero signal by pre-caching the app shell:
// index.html, the manifest, the icons, and the vendored third-party libraries
// in ./vendor/. Inspection DATA is a separate concern, handled by IndexedDB in
// index.html — this file only makes the app *load* offline, it is not the data
// storage layer.
//
// When you change any shell file (including swapping a vendored library
// version), update SHELL_FILES below and bump CACHE_NAME so installed clients
// discard the stale copy instead of serving it forever.

const CACHE_NAME = 'promanage-shell-v10';

// How long a cold launch waits for the network before serving the cached shell.
// Navigation is network-first so a deploy is picked up promptly, but "the
// network is unreachable" and "the network is answering, very slowly" are
// different failures and only the first one rejects. On a weak connection —
// which for this app means standing inside someone's rental — fetch() neither
// resolves nor rejects for as long as the browser is willing to wait, and the
// app hangs on a blank page with a perfectly good copy of itself in the cache.
// Three seconds is longer than any healthy connection needs and far shorter
// than the browser's own timeout.
const NAVIGATION_NETWORK_TIMEOUT_MS = 3000;

const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './vendor/supabase-js-2.111.0.umd.js',
  './vendor/jspdf-2.5.2.umd.min.js',
  './vendor/jspdf-autotable-3.8.2.min.js',
  './vendor/heic2any-0.0.4.min.js',
  // Loaded on demand by loadPdfEngine() in index.html, not by a <script src>.
  // Still pre-cached here: that is what keeps offline PDF generation working.
  './reports/pdf-reports.js'
];

// Absolute URLs for the shell, resolved once against the worker's scope so
// lookups are an exact Set hit rather than a fuzzy endsWith() match.
const SHELL_URLS = new Set(SHELL_FILES.map((f) => new URL(f, self.registration.scope).href));
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

// Install: pre-cache the app shell.
// Files are added one at a time because cache.addAll() is all-or-nothing — a
// single 404 (a renamed vendor file, say) would otherwise leave the app with no
// offline copy at all. A partial cache degrades far better than none.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_FILES.map((file) =>
          cache.add(new Request(file, { cache: 'reload' })).catch((err) => {
            // Still one at a time — one 404 must not cost the whole shell. But
            // a miss here leaves a file that only the network can serve, so it
            // is worth being loud about rather than leaving it to be
            // rediscovered as a broken app later.
            console.warn('[sw] failed to pre-cache ' + file + ' — it will be fetched from the network on demand', err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate: clear out old cache versions, then take over open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

// Serve from cache, then refresh the cached copy in the background so the next
// load gets the newer file. Used for the shell: instant offline start, without
// pinning the app to a stale build forever.
// Every path here MUST resolve to a Response. It previously did `.catch(() =>
// cached)` and `return cached || network`, so a shell file that was not in the
// cache AND could not be fetched resolved to `undefined` — and respondWith() on
// undefined fails the request outright. For a <script src> that means the
// library silently never loads, which is how the app came to report
// "Cannot access 'sb' before initialization" and keep reporting it: install
// only warns when a shell file fails to pre-cache, so the gap persists and
// every later load takes the same dead path.
async function cacheFirstRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    // Refresh in the background; failure here is fine, we already have a copy.
    fetch(request)
      .then((response) => {
        if (response && response.ok) return cache.put(request, response.clone());
      })
      .catch(() => {});
    return cached;
  }

  // Nothing cached — this is the path that used to return undefined.
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    console.warn('[sw] ' + request.url + ' is neither cached nor reachable', err);
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }
}

/* Network-first with a deadline, falling back to the cached shell.
 *
 * The timer does NOT abort the request — the network copy is still worth
 * having, so it keeps running and refreshes the cache whenever it lands, ready
 * for the next launch. All the deadline decides is how long the user waits
 * before being handed the copy we already have.
 *
 * Like every other branch in this file, every path here must resolve to a
 * Response: respondWith() on a promise resolving to undefined fails the
 * navigation outright, which for a cold launch is a blank page.
 */
async function navigateWithTimeout(request) {
  const cache = await caches.open(CACHE_NAME);

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(INDEX_URL, response.clone());
      return response;
    });
  // The network arm can reject (offline). Swallow it here so the race below
  // settles on the timeout rather than on an unhandled rejection, and so a
  // rejection with nothing cached still falls through to the check underneath.
  const networkOrNull = network.catch(() => null);

  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), NAVIGATION_NETWORK_TIMEOUT_MS));

  const winner = await Promise.race([networkOrNull, timeout]);
  if (winner && winner !== 'timeout') return winner;

  // Either the network lost the race or it failed. Prefer the cached shell.
  const cached = await cache.match(INDEX_URL);
  if (cached) return cached;

  // Nothing cached — we have no choice but to wait for the network after all.
  const late = await networkOrNull;
  return late || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET is cacheable, and only our own origin is ours to cache.
  // Everything else — Supabase REST and auth calls above all — goes straight
  // to the network untouched. Caching those would serve stale rows while
  // offline and silently swallow writes.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so a deploy is picked up promptly, but fall
  // back to the cached index.html — this is what makes a cold offline launch
  // (and the installed PWA icon) work at all.
  if (request.mode === 'navigate') {
    event.respondWith(navigateWithTimeout(request));
    return;
  }

  if (SHELL_URLS.has(url.href)) {
    event.respondWith(cacheFirstRevalidate(request));
    return;
  }

  // Any other same-origin GET: network first, cached copy as offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
