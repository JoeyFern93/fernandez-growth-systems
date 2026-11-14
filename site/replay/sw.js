'use strict';
const CACHE_PREFIX = 'fgs-replay-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-14-brand-v2.0';
const APP_SHELL = ["./", "./index.html", "./css/app.css", "./js/app.js", "./js/replay-ui.js", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/icon-maskable-512.svg", "../favicon.ico", "../assets/brand/website/fgs-brand.css", "../assets/brand/replay-brand.css", "../assets/brand/fonts/Nunito-Variable.woff2", "../assets/brand/logos/FGS-Logo-White.svg", "../assets/brand/icons/FGS-JF-Leaf-White.svg", "../assets/brand/icons/FGS-JF-Leaf-Green.svg"];
const scope = new URL(self.registration.scope);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.origin) return;
  const isNavigation = event.request.mode === 'navigate';
  const shellKey = isNavigation ? new URL('./', scope).href : new URL(url.pathname, scope.origin).href;
  const allowed = APP_SHELL.some(path => new URL(path, scope).href === shellKey);
  if (!allowed) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(shellKey, response.clone());
      return response;
    } catch {
      return (await cache.match(shellKey)) || Response.error();
    }
  })());
});
