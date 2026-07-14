// ProManage NZ — service worker
// Caches the app shell so the app itself opens with zero signal.
// Inspection DATA is handled separately via IndexedDB (see promanage-nz.html) —
// this file only makes the app loadable offline, not the data storage layer.

const CACHE_NAME = 'promanage-shell-v1';
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate: clear out old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for the app shell, network-first with cache fallback for everything else.
// This app currently has no external API calls — once you wire up Supabase/Drive,
// those requests will naturally fall into the "network-first" branch below and
// won't be cached (so live data always tries the network first).
self.addEventListener('fetch', (event) => {
  const isShellFile = SHELL_FILES.some((f) => event.request.url.endsWith(f.replace('./', '')));

  if (isShellFile) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
