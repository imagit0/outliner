// Service worker: makes the app load offline.
// Network-first for our own files (so updates show up immediately when
// online), falling back to the cache. Dropbox requests are not touched.
// The network fetch carries a unique tag (?fresh=...) so neither the
// browser's HTTP cache nor GitHub's CDN (which keeps each file up to 10
// minutes) can answer with an old copy right after a release.

const CACHE = 'outliner-v35';
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
  'js/idb.js',
  'js/local.js',
  'js/shards.js',
  'js/merge.js',
  'js/menu.js',
  'js/model.js',
  'js/opml.js',
  'js/select.js',
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
  const url = new URL(req.url);
  url.searchParams.set('fresh', Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  e.respondWith(
    fetch(url, { cache: 'no-store', credentials: 'same-origin' })
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
