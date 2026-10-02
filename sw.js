const CACHE_NAME = 'edm26-pwa-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // No interceptar llamadas en vivo a JSONBin o Telegram API para mantener sincronización en tiempo real
  if (url.hostname.includes('jsonbin.io') || url.hostname.includes('telegram.org')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
