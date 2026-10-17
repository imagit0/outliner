// Service worker: makes the app load offline.
// Network-first for our own files (so updates show up immediately when
// online), falling back to the cache. Dropbox requests are not touched.
// The network fetch revalidates with the server ("no-cache") instead of
// trusting the browser's HTTP cache, which GitHub Pages sets to 10 minutes.

const CACHE = 'outliner-v17';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/backup.js',
  'js/config.js',
  'js/dropbox.js',
  'js/drag.js',
  'js/format.js',
  'js/merge.js',
  'js/menu.js',
  'js/model.js',
  'js/opml.js',
  'js/store.js',
  'js/sync.js',
  'js/table.js',
  'js/ui.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
