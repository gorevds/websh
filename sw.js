// websh service worker — notification surface only.
//
// Mobile Chrome (and increasingly desktop Chrome) refuses to construct
// notifications via `new Notification(...)` and requires
// ServiceWorkerRegistration.showNotification() — which needs a real
// registered service worker even if it does nothing else.
//
// This SW deliberately does NOT intercept fetch. websh is an
// SSH terminal — there's no point caching it for offline use, and
// silently serving stale assets would be a footgun. The only reason
// the SW exists is to wrap showNotification() and to surface tab
// focus when the user taps the resulting toast.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const scope = self.registration.scope;
    const clients = await self.clients.matchAll(
      {type: 'window', includeUncontrolled: true});
    for (const c of clients) {
      if (c.url.startsWith(scope) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(scope);
  })());
});
