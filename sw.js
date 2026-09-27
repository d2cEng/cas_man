// Offline shell. Bump CACHE when any precached file changes.
const CACHE = 'cas-man-v5';

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
      // Straight from the server, or a new worker could install last deploy's files.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
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

/**
 * The same response, marked for revalidation.
 *
 * The page keeps its own in-memory copy of each script and reuses it on a
 * refresh for as long as the headers say it is fresh — without asking this
 * worker at all. Passed through as-is, GitHub's max-age=600 would let a
 * refresh run the old modules for ten minutes after a deploy.
 */
function revalidated(response) {
  if (!response.ok || response.type !== 'basic') return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
  //
  // "Network" has to mean the server, not the browser's HTTP cache: GitHub
  // Pages sends max-age=600, so a plain fetch kept handing back the old files
  // for ten minutes after a deploy — a refresh showed the old app. no-cache
  // revalidates every time; an unchanged file costs only a 304 on its ETag.
  // A navigation request cannot be re-issued with options, so it goes by URL.
  // The response is then marked no-cache too (revalidated()), or the page's
  // own memory cache would skip this worker on the next refresh.
  const fresh =
    request.mode === 'navigate'
      ? fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
      : fetch(new Request(request, { cache: 'no-cache' }));

  event.respondWith(
    fresh
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return revalidated(response);
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return revalidated(cached);
        // Navigations carry the widget/share query string; any cached shell
        // will do, since the app reads those parameters itself.
        if (request.mode === 'navigate') {
          const shell = await caches.match('index.html', { ignoreSearch: true });
          if (shell) return revalidated(shell);
        }
        return Response.error();
      }),
  );
});
