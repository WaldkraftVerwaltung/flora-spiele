// Service Worker für Autorennen — Cache-Strategie:
//  • HTML / Navigationen: NETWORK-FIRST. Neue Version sofort sichtbar, wenn
//    online. Nur bei fehlendem Netz wird aus dem Cache geliefert.
//  • Andere Assets (Manifest, Icons, ...): STALE-WHILE-REVALIDATE —
//    schnell aus Cache, parallel im Hintergrund auffrischen.
// Cache-Nummer hochzählen, wenn Kern-Dateien sich ändern.
const CACHE = 'autorennen-v9';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const url = new URL(req.url);
  const isHTML = req.mode === 'navigate'
    || (req.headers.get('accept') || '').includes('text/html')
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('/');

  if (isHTML) {
    // Network-first, Cache als Offline-Fallback
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() =>
        caches.match(req).then(c => c || caches.match('./index.html'))
      )
    );
  } else {
    // Stale-while-revalidate für Assets
    e.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
