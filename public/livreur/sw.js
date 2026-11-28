// Garde l'appli livreur disponible même avec un réseau faible (pages et scripts en cache).
const CACHE = 'kc-livreur-v8';
const FILES = ['/livreur/', '/assets/app.css', '/assets/app.js', '/vendor/html5-qrcode/html5-qrcode.min.js', '/livreur/manifest.json', '/assets/nav.js', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/livreur/icon.svg', '/assets/phoenix.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return; // les données passent toujours par le réseau
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
