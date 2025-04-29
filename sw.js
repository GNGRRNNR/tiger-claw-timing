// sw.js - Basic Service Worker for Caching App Shell

const CACHE_NAME = 'runner-tracker-cache-v1'; // Change version to force update
const urlsToCache = [
    '/', // Cache the root HTML
    'index.html',
    'app.js',
    'db.js',
    'manifest.json',
    // Add paths to icons if you have them (e.g., 'images/icon-192x192.png')
    'https://cdn.tailwindcss.com', // Cache Tailwind
    'https://unpkg.com/html5-qrcode', // Cache QR Scanner lib
    'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js', // Cache Tone.js
    // Cache Google Fonts (less critical, but can improve offline load)
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap',
    'https://fonts.gstatic.com/s/inter/v13/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7W0Q5nw.woff2' // Example font file - check Network tab for actual URLs used
];

// Install event: Cache core assets
self.addEventListener('install', event => {
    console.log('Service Worker: Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Service Worker: Caching app shell');
                return cache.addAll(urlsToCache);
            })
            .then(() => {
                console.log('Service Worker: Installation complete');
                return self.skipWaiting(); // Activate immediately
            })
            .catch(error => {
                 console.error('Service Worker: Caching failed', error);
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

// Fetch event: Serve cached assets first, fall back to network
self.addEventListener('fetch', event => {
    // Let browser handle requests for Google Apps Script (don't cache POSTs or script data)
    if (event.request.url.includes('script.google.com')) {
        // console.log('Service Worker: Bypassing cache for Apps Script request:', event.request.url);
        return; // Let the network handle it directly
    }
     // Let browser handle non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }


    // For other GET requests, try cache first
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    // console.log('Service Worker: Serving from cache:', event.request.url);
                    return response; // Serve from cache
                }
                // console.log('Service Worker: Fetching from network:', event.request.url);
                return fetch(event.request)
                        .then(networkResponse => {
                            // Optional: Cache dynamically fetched resources if needed
                            // Be careful not to cache everything, especially large files or APIs
                            // Example: Cache images or fonts loaded later
                            // if (networkResponse.ok && event.request.url.includes('/images/')) {
                            //    const responseToCache = networkResponse.clone();
                            //    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
                            // }
                            return networkResponse;
                        })
                        .catch(error => {
                             console.error('Service Worker: Fetch failed:', error);
                             // Optional: Return a fallback offline page if appropriate
                             // return caches.match('/offline.html');
                        });
            })
    );
});

// --- Optional: Background Sync (More complex) ---
/*
// Example using Background Sync API (check browser compatibility)
self.addEventListener('sync', event => {
  if (event.tag === 'sync-scans') {
    console.log('Service Worker: Background sync event triggered for "sync-scans"');
    // Add logic here to fetch unsynced scans from IndexedDB
    // and send them to the server using fetch().
    // This runs even if the app tab is closed.
    // event.waitUntil(syncDataToServer());
  }
});

async function syncDataToServer() {
    // Needs access to IndexedDB functions (might need to duplicate db.js logic or use a shared worker/module)
    // Fetch unsynced scans
    // Loop and POST to Apps Script
    // Update status in IndexedDB on success
}
*/
