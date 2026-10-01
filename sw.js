// Offline support. The app shell is cached on install; requests go to the network first so a new
// deploy shows up right away, and fall back to the cache when offline.
const VERSION = 'dev'; // replaced with the commit SHA by the deploy workflow
const CACHE = `cb10-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/main.js',
  'js/ble.js',
  'js/control.js',
  'js/mock.js',
  'js/probe.js',
  'js/program.js',
  'js/protocol.js',
  'js/util.js',
  'fonts/plex-mono-latin-400.woff2',
  'fonts/plex-mono-latin-ext-400.woff2',
  'fonts/plex-mono-latin-600.woff2',
  'fonts/plex-mono-latin-ext-600.woff2',
  'fonts/plex-mono-latin-700.woff2',
  'fonts/plex-mono-latin-ext-700.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('cb10-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      // ignoreSearch so "?mock=1" and friends still open offline.
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('./')) || cache.match('index.html');
      return Response.error();
    }
  })());
});
