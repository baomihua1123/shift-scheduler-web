// Service Worker：讓程式安裝後可離線開啟，並在有新版本時通知使用者。
// 每次更新程式時，請同時修改這裡的 VERSION 與 js/version.js（兩邊必須一致）。
const VERSION = '1.3.0';
const CACHE = `shift-scheduler-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/version.js',
  './js/util.js',
  './js/idb.js',
  './js/store.js',
  './js/timeslots.js',
  './js/engine.js',
  './js/engine-worker.js',
  './js/event-model.js',
  './js/zip.js',
  './js/xlsx.js',
  './js/excel-io.js',
  './js/folder-storage.js',
  './js/ui/dialog.js',
  './js/ui/files.js',
  './js/ui/status.js',
  './js/ui/setup.js',
  './js/ui/staff-tab.js',
  './js/ui/settings-tab.js',
  './js/ui/events-tab.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('shift-scheduler-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has('nocache')) return; // 「檢查更新」要直接向網站確認，不使用快取
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const index = await cache.match('./index.html');
        if (index) return index;
      }
      throw err;
    }
  })());
});
