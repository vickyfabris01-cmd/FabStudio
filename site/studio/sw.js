// FabStudio service worker: makes the app open offline.
// Files are served from cache instantly and refreshed in the background,
// so a new deploy shows up on the second open. Bump CACHE only to force a full reset.
const CACHE = 'fabstudio-shell-v8';
const SHELL = [
  '/studio/', '/studio/index.html', '/studio/manifest.webmanifest', '/studio/css/studio.css',
  '/studio/js/app.js', '/studio/js/db.js', '/studio/js/ui.js', '/studio/js/auth.js', '/studio/js/api.js',
  '/studio/js/sync.js', '/studio/js/recorder.js', '/studio/js/mixer.js', '/studio/js/baker.js', '/studio/js/publish.js', '/studio/js/publisher.js', '/studio/js/thumbs.js', '/studio/js/live.js', '/studio/js/live-engine.js', '/studio/js/live-audio.js',
  '/studio/js/console/header.js', '/studio/js/console/stats.js', '/studio/js/console/reading.js', '/studio/js/console/myaudio.js', '/studio/js/console/deck.js', '/studio/js/console/chatfeed.js', '/studio/js/console/settings-modal.js', '/studio/js/console/recap.js', '/studio/js/console/webm-cut.js', '/shared/live-socket.js', '/shared/sfu.js', '/shared/live-settings.js',
  '/studio/icons/icon-192.png', '/studio/icons/icon-512.png',
  '/shared/config.js', '/shared/supabase.js', '/shared/vendor/dexie.min.js', '/shared/vendor/supabase.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Supabase and the Worker are never cached
  if (!url.pathname.startsWith('/studio/') && !url.pathname.startsWith('/shared/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('/studio/index.html') : null);
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || Response.error();
  })());
});
