// sw.js - Basic Service Worker for Caching App Shell

const CACHE_NAME = 'runner-tracker-cache-v2'; // Increment version on changes
const CORE_ASSETS = [
    '/', // Cache the root HTML
    'index.html', // Explicitly cache index.html
    'app.js',
    'db.js',
    'manifest.json'
    // Add paths to local icons if you created them e.g., 'images/icon-192x192.png'
];

const EXTERNAL_ASSETS = [
     'https://cdn.tailwindcss.com', // Tailwind CSS
     'https://unpkg.com/html5-qrcode', // QR Scanner lib
     'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js', // Tone.js
     // Google Fonts (optional, less critical)
     // 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap',
     // 'https://fonts.gstatic.com/s/inter/v13/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7W0Q5nw.woff2'
];

// Install event: Cache core assets first, then external assets non-blockingly
self.addEventListener('install', event => {
    console.log('Service Worker: Installing...');

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Service Worker: Caching core assets...');
                // Cache core assets - installation fails if these fail
                return cache.addAll(CORE_ASSETS)
                    .then(() => {
                        console.log('Service Worker: Core assets cached.');
                        // Attempt to cache external assets, but don't block installation if they fail
                        console.log('Service Worker: Attempting to cache external assets...');
                        cache.addAll(EXTERNAL_ASSETS).catch(error => {
                            console.warn('Service Worker: Failed to cache some external assets:', error);
                            // Installation still succeeds even if external assets fail
                        });
                    });
            })
            .then(() => {
                console.log('Service Worker: Installation process complete (core assets cached).');
                return self.skipWaiting(); // Activate immediately
            })
            .catch(error => {
                 console.error('Service Worker: Caching core assets failed, installation aborted.', error);
            })
    );
});

// Activate event: Clean up old caches
self.addEventListener('activate', event => {
    console.log('Service Worker: Activating...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Service Worker: Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
             console.log('Service Worker: Activation complete');
             return self.clients.claim(); // Take control of existing clients
        })
    );
});

// Fetch event: Serve cached assets first (Cache First strategy)
self.addEventListener('fetch', event => {
    // Ignore non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Ignore requests to Google Apps Script (don't cache POSTs or dynamic data)
    if (event.request.url.includes('script.google.com')) {
        // console.log('Service Worker: Bypassing cache for Apps Script request:', event.request.url);
        // Fall back to network, don't try cache
        event.respondWith(fetch(event.request));
        return;
    }

    // For other GET requests, try cache first
    event.respondWith(
        caches.match(event.request)
            .then(cachedResponse => {
                // Return cached response if found
                if (cachedResponse) {
                    // console.log('Service Worker: Serving from cache:', event.request.url);
                    return cachedResponse;
                }

                // If not in cache, fetch from network
                // console.log('Service Worker: Fetching from network:', event.request.url);
                return fetch(event.request)
                    .then(networkResponse => {
                         // Optional: Dynamically cache successfully fetched external assets
                         // Only cache successful responses and external assets if desired
                         if (networkResponse.ok && EXTERNAL_ASSETS.some(url => event.request.url.startsWith(url))) {
                             const responseToCache = networkResponse.clone(); // Clone response
                             caches.open(CACHE_NAME)
                                 .then(cache => {
                                     // console.log('Service Worker: Caching fetched external asset:', event.request.url);
                                     cache.put(event.request, responseToCache);
                                 });
                         }
                         return networkResponse; // Return original network response
                    })
                    .catch(error => {
                        console.error('Service Worker: Fetch failed; returning offline fallback or error for:', event.request.url, error);
                        // Optional: Return a generic offline fallback page for HTML requests
                        // if (event.request.mode === 'navigate') {
                        //     return caches.match('/offline.html'); // You would need to cache an offline.html page
                        // }
                        // For other asset types, just let the browser handle the error
                    });
            })
    );
});
