// Fabris Poet (public site) service worker. It exists so the site can be installed, and to show a friendly page
// when someone opens it with no connection. It never stores poems, audio, video or API answers: everything else
// goes straight to the network, so the live, reactions and comments behave exactly as before.
// The Studio has its own service worker (/studio/sw.js) and is left alone here.
const CACHE = 'fabris-public-v3';
const OFFLINE = '/offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/img/fabris-poet-mark.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('fabris-public-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;      // only page opens; all else is untouched
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/studio/')) return;
  e.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
});
