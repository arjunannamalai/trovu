// Bump CACHE_NAME whenever the set of precached assets changes; the activate
// handler below purges any cache that does not match the current name.
const CACHE_NAME = "trovu-v2";
const urlsToCache = [
  "/",
  "/index.html",
  "/process/index.html",
  "/index.js",
  "/process.js",
  "/data.json",
  "/style.css",
  "/main.js",
  "/manifest.json",
  "/favicon.ico",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  // Include additional essential assets as needed
];

self.addEventListener("install", (event) => {
  // Activate this worker as soon as it has finished installing, so updated
  // code reaches the (installed) PWA without needing every tab to be closed.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache)));
});

self.addEventListener("activate", (event) => {
  // Drop stale caches from previous versions, then take control of open clients.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network-first strategy: always try the network so the freshest code and data
// are served when online (a previous cache-first worker pinned installed PWAs
// to stale JS indefinitely). Fall back to the cache only when offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
