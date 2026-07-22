// BUMP THIS VERSION on every commit that changes a shell file
// (dashboard.html, manifest.json, icons) -- otherwise the SW serves
// stale cached HTML and deployed fixes never reach users.
const CACHE = 'vp-shell-v30';
const SHELL = [
  '/dashboard.html',
  '/login.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Skip API calls and cross-origin requests
  if (url.pathname.startsWith('/api/') || url.hostname !== location.hostname) return;
  // Mockup files: network-only, never cache
  if (url.pathname.includes('-mockup')) return;
  // HTML documents: network-first, cache fallback (shell pages only)
  if (url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          var clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Static assets: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
