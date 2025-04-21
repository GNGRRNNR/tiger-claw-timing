// Cache name with version
const CACHE_NAME = "tiger-claw-timing-v1"

// Files to cache
const urlsToCache = ["/", "/index.html", "/manifest.json", "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"]

// Install event - cache assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Opened cache")
      return cache.addAll(urlsToCache)
    }),
  )
})

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  const cacheWhitelist = [CACHE_NAME]
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName)
          }
        }),
      )
    }),
  )
})

// Fetch event - serve from cache or network
self.addEventListener("fetch", (event) => {
  // Skip cross-origin requests
  if (event.request.url.startsWith(self.location.origin) || event.request.url.includes("unpkg.com")) {
    event.respondWith(
      caches.match(event.request).then((response) => {
        // Cache hit - return response
        if (response) {
          return response
        }

        // Clone the request
        const fetchRequest = event.request.clone()

        // For API calls, use network-first strategy
        if (event.request.url.includes("script.google.com")) {
          return fetch(fetchRequest).catch(() => {
            // If network fails, return a custom offline response for API
            return new Response(
              JSON.stringify({
                offline: true,
                message: "You are offline. This request will be sent when you reconnect.",
              }),
              {
                headers: { "Content-Type": "application/json" },
              },
            )
          })
        }

        // For other resources, use cache-first with network fallback
        return fetch(fetchRequest)
          .then((response) => {
            // Check if we received a valid response
            if (!response || response.status !== 200 || response.type !== "basic") {
              return response
            }

            // Clone the response
            const responseToCache = response.clone()

            // Add to cache
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache)
            })

            return response
          })
          .catch(() => {
            // If both cache and network fail, return a generic offline page
            if (event.request.mode === "navigate") {
              return caches.match("/index.html")
            }
          })
      }),
    )
  }
})

// Handle background sync for pending uploads
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-pending-scans") {
    event.waitUntil(syncPendingScans())
  }
})

// Function to sync pending scans
async function syncPendingScans() {
  try {
    // This would be implemented to sync data from IndexedDB
    // For now, we'll just log that sync was attempted
    console.log("Background sync attempted for pending scans")
  } catch (error) {
    console.error("Background sync failed:", error)
  }
}
