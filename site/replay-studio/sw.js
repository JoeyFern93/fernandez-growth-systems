'use strict';

// Previous Studio installs still check this exact URL for updates.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // With no fetch handler, open sessions continue through the network and
    // their next navigation follows the site's redirects to the new tool URLs.
    await self.clients.claim();
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith('fgs-studio-replay-'))
        .map(key => caches.delete(key)));
    } catch { /* Storage access is optional for retiring the old scope. */ }
    await self.registration.unregister();
  })());
});
