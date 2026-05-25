/* PokeFinder Service Worker */
'use strict';

const CACHE_VERSION = 'pokefinder-v1';

// App shell files — loaded synchronously on boot
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data/pokedex-index.js',
  './data/pokedex-manifest.js',
];

// Chunk files from the manifest — added after the SW installs
// We read them from the cached manifest or hard-code the expected filenames.
// Using a fixed pattern here so the SW is self-contained.
const CHUNK_FILES = Array.from({ length: 6 }, (_, i) => `./data/pokedex-chunk-${i}.js`);

const PRECACHE_URLS = [...APP_SHELL, ...CHUNK_FILES];

// ---- Install: precache app shell + all chunks --------------------------------
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      console.log('[SW] Precaching', PRECACHE_URLS.length, 'files');
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// ---- Activate: clean up old caches ------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ---- Fetch: cache-first for same-origin + sprites cache ----------------------
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET
  if (event.request.method !== 'GET') return;

  // Sprite/artwork CDN (raw.githubusercontent.com): cache-first, stale-while-revalidate
  if (url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // Same-origin requests (app shell + data chunks): cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Google Fonts and other CDN assets: cache-first
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Everything else: network pass-through (no caching)
});

// Cache-first: serve from cache, fall back to network, update cache on miss
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline and not cached
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// Stale-while-revalidate: serve cached immediately, update in background
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then(response => {
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || await networkPromise || new Response('Offline', { status: 503 });
}
