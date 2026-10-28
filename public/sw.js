const CACHE = "mehrak-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
self.addEventListener("install", (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => {
    const fresh = fetch(request).then((response) => { if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone())); return response; }).catch(() => cached);
    return cached || fresh;
  }));
});
self.addEventListener("push", (event) => {
  let data = { title: "هشدار مِهرَک", body: "رویداد تازه در سامانه", url: "/alerts" };
  try { data = { ...data, ...event.data.json() }; } catch { /* text/empty pushes use the safe default */ }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: data.url }, tag: "mehrak-alert", renotify: false }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/alerts";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => windows.length ? windows[0].focus() : clients.openWindow(url)));
});
