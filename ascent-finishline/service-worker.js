// ascent-finishline/service-worker.js

const CACHE_NAME = 'ascent-finishline-cache-v1';
const urlsToCache = [
  '/tiger-claw-timing/ascent-finishline/',
  '/tiger-claw-timing/ascent-finishline/index.html',
  '/tiger-claw-timing/ascent-finishline/manifest.json',
  '/tiger-claw-timing/icons/icon-192x192.png',
  '/tiger-claw-timing/icons/icon-512x512.png'
];

// Install Service Worker
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Install');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching app shell');
        return cache.addAll(urlsToCache);
      })
      .catch((err) => {
        console.error('[Service Worker] Error caching', err);
      })
  );
});

// Activate Service Worker
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activate');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((cacheName) => {
          return cacheName !== CACHE_NAME;
        }).map((cacheName) => caches.delete(cacheName))
      );
    })
  );
});

// Fetch requests
self.addEventListener('fetch', (event) => {
  if (event.request.url.startsWith('chrome-extension://')) {
    return; // Ignore Chrome extension requests
  }
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        return response || fetch(event.request);
      })
  );
});
