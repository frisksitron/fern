/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `fern-${version}`;
const assets = new Set([...build, ...files]);

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.addAll(assets))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('fern-') && key !== cacheName).map((key) => caches.delete(key)),
        ),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return;

  // Away from home with the server out of reach, the installed app says so instead of showing the
  // browser's error page.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => (await caches.match('/offline.html')) ?? Response.error()),
    );
    return;
  }

  if (!assets.has(url.pathname)) return;

  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});
