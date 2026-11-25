/* Offline support: keeps the app's own files on the phone. Data is in IndexedDB, not here.
   When you change any app file, raise VERSION so phones fetch the new files. */
const VERSION = 'bondstore-1.0.6';
const FILES = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './vendor/zxing.min.js', './vendor/fflate.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' = fetch from the website, not from the browser's own HTTP cache (GitHub Pages
  // lets browsers keep files for 10 minutes, which could mix old and new files in an update).
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() =>
      req.mode === 'navigate' ? caches.match('./index.html') : Response.error())),
  );
});
