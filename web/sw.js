const SHELL_CACHE = 'hearthwave-shell-v33';
const SHELL = ['/', '/styles.css', '/app.js', '/tv-navigation.js', '/playback-variants.js', '/hls-playback.js', '/playback-diagnostics.js', '/local-media.js', '/space.js', '/workers.js', '/rooms.js', '/requests.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== SHELL_CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
