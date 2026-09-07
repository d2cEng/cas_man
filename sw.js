// Offline shell. Bump CACHE when any precached file changes.
const CACHE = 'cas-man-v3';

// Relative URLs so the app works from any path on any static host.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/styles.css',
  'assets/app.js',
  'assets/store.js',
  'assets/sync.js',
  'assets/transfer.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch Google's auth/Firestore traffic, and never cache writes.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Network first, cache only as the offline fallback.
  //
  // Cache-first froze installed copies on whatever shipped the day the cache
  // name last changed — a deploy that fixed a bug simply never reached anyone
  // who had opened the app before. Correct code matters more here than saving
  // a few KB on a page this small, and offline still works through the
  // fallback below.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        // Navigations carry the widget/share query string; any cached shell
        // will do, since the app reads those parameters itself.
        if (request.mode === 'navigate') {
          return caches.match('index.html', { ignoreSearch: true });
        }
        return Response.error();
      }),
  );
});
