const CACHE = "photogallery-thumbs-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  if (!e.request.url.includes("/thumbnails/")) return;
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(hit =>
        hit ?? fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
      )
    )
  );
});
