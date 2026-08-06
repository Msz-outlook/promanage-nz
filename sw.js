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

const CACHE_NAME = 'promanage-shell-v5';

const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './vendor/supabase-js-2.111.0.umd.js',
  './vendor/jspdf-2.5.2.umd.min.js',
  './vendor/jspdf-autotable-3.8.2.min.js',
  './vendor/heic2any-0.0.4.min.js'
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
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(INDEX_URL, clone));
          }
          return response;
        })
        .catch(() => caches.match(INDEX_URL).then((cached) => cached || Response.error()))
    );
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
