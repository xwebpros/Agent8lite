/* Only generic, original public assets and hashed build assets may be persisted. */
const CACHE = "estate-static-v1";
const GENERIC = [
  "/offline.html",
  "/icons/app-192.png",
  "/icons/app-512.png",
  "/icons/app-maskable-512.png",
  "/icons/apple-touch-icon.png",
];
function allowed(url) {
  return (
    url.origin === self.location.origin &&
    !url.search &&
    (GENERIC.includes(url.pathname) ||
      /^\/_next\/static\/.*[a-f0-9]{8,}.*\.(?:js|css|woff2?)$/.test(url.pathname))
  );
}
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(GENERIC)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("estate-static-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (allowed(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === "basic") await cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }
  // Personalized HTML/RSC and API responses always pass directly to the network.
  if (request.mode === "navigate" && url.origin === self.location.origin) {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/offline.html").then((response) => response || Response.error()),
      ),
    );
  }
});
