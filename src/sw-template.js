/* Meshlight service worker (spec §5.6).
 *
 * Every file in the build is precached on install, so a single visit is
 * enough to make the app work with the network off for good. The list and the
 * cache name are injected by the serviceWorker() plugin in vite.config.ts,
 * which means a new build always lands in a fresh cache and the old one is
 * dropped on activate.
 *
 * There is no runtime API to fall back to — the app makes no network requests
 * of its own — so a cache miss offline only ever means a genuinely new asset.
 */

// The cache name and the SHELL list below are both injected by the build.
// The list has to be built at build time: the app registers this worker on
// window load, by which point the browser has already fetched index.html, the
// JS and the CSS, so those requests never reach the fetch handler and runtime
// caching alone would never see them.
const CACHE = 'meshlight-__REVISION__'
const SHELL = __PRECACHE__

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Fetch each entry itself rather than using addAll, which rejects the
      // whole batch if any single request fails.
      .then((cache) =>
        Promise.all(
          SHELL.map((url) =>
            fetch(new Request(url, { cache: 'reload' }))
              .then((response) => (response.ok ? cache.put(url, response) : undefined))
              .catch(() => undefined),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // ignoreVary matters: static hosts commonly send `Vary: Origin`, and the
  // precache requests carry no Origin header while the page's module-script
  // requests do. Without this, every precached asset misses on a real load.
  event.respondWith(
    caches.match(request, { cacheName: CACHE, ignoreVary: true }).then((hit) => {
      if (hit) return hit
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(async () => {
          // Offline and uncached: a navigation should still land on the app.
          if (request.mode === 'navigate') {
            const shell = await caches.match('index.html', { cacheName: CACHE, ignoreVary: true })
            if (shell) return shell
          }
          throw new Error('offline and not cached')
        })
    }),
  )
})
