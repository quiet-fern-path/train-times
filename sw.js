// Bump this string whenever the app shell itself changes shape
// (not needed for routine data refreshes — those are handled below).
const CACHE = 'timetables-v5';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stale-while-revalidate: if a cached copy exists, return it INSTANTLY —
// no network round trip on the critical path at all. A background fetch
// still runs to refresh the cache, but the page never waits on it.
// Only a true first-ever visit (nothing cached yet) has to wait for the
// network, because there's nothing else to show.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Only cache same-origin (app shell + schedule data). Cross-origin requests
  // are the live Darwin API calls, which must always hit the network fresh —
  // caching them would mean "reconnecting" silently serves stale delay/
  // platform data instead of the live overlay's own fetch actually running.
  if (new URL(e.request.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);

      const networkUpdate = fetch(e.request)
        .then(response => {
          if (response.ok) cache.put(e.request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        // Don't await — let the refresh happen quietly in the background.
        networkUpdate;
        return cached;
      }

      // Nothing cached yet: this is the one case that must wait.
      const fresh = await networkUpdate;
      if (fresh) return fresh;

      return new Response(
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Offline</title>
        <style>
          body{font-family:sans-serif;display:flex;flex-direction:column;
            align-items:center;justify-content:center;min-height:100dvh;
            margin:0;background:#eef0f5;color:#111827;text-align:center;padding:24px}
          h1{font-size:1.4rem}
          p{color:#64748b;max-width:320px;line-height:1.5}
        </style></head><body>
        <h1>📵 You're offline</h1>
        <p>Open this page once while connected and it will be saved
           for instant offline use from then on.</p>
        </body></html>`,
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })
  );
});
