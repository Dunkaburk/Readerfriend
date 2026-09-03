/**
 * Readerfriend offline shell (§7).
 *
 * Caches the app shell so the SPA loads on a plane:
 *  - navigations: network first (deploys land immediately), cache fallback;
 *  - hashed /assets/: cache first (immutable content);
 *  - /api/* is never touched — books, metadata and audio live in IndexedDB
 *    and the API must fail loudly when offline, not serve stale answers.
 */

const CACHE = 'rf-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['/index.html']))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put(req.url, copy))
              .catch(() => undefined);
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req.url)
            .then((hit) => hit || caches.match('/index.html'))
            .then((hit) => hit || Response.error()),
        ),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches
                .open(CACHE)
                .then((c) => c.put(req, copy))
                .catch(() => undefined);
            }
            return res;
          }),
      ),
    );
  }
});
