'use strict';
const CACHE_PREFIX = 'fgs-replay-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-21-tv-recovery-v2';
const APP_SHELL = [
  './', './css/app-v10.css', './css/dashboard-v11.css', './js/dashboard-v11.js',
  './js/frame-times-v1.js', './js/frame-export-v1.js', './js/app-v11.js', './js/replay-ui.js',
  './tv/pair.js', './tv/relay-media.js', './tv/pair.css', './manifest-v3.webmanifest', './js/install-v4.js',
  '../favicon-v5.ico', '../favicon-v5.svg', '../favicon-v5-32.png', '../assets/tool-install-v1.css',
  '../assets/brand/website/fgs-brand-v3.css', '../assets/brand/replay-brand-v3.css',
  '../assets/brand/fonts/Nunito-Variable.woff2', '../assets/brand/icons/FGS-JF-Leaf-Green-v3.svg',
  './icons/fgs-192-v4.png', './icons/fgs-512-v4.png', './icons/fgs-maskable-512-v4.png', './icons/fgs-apple-180-v4.png'
];
const scope = new URL(self.registration.scope);
const rootKey = new URL('./', scope).href;
const shellKeys = new Set(APP_SHELL.map(path => new URL(path, scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL.map(path => new Request(new URL(path, scope), {cache: "reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.origin) return;
  const isNavigation = event.request.mode === 'navigate';
  // The TV landing page, phone invitation and every query-bearing navigation
  // must reach their own server route. Never substitute the Replay Cam shell.
  if (isNavigation !== (url.href === rootKey)) return;
  const shellKey = url.href;
  if (!shellKeys.has(shellKey)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request);
      if (response.ok && !response.redirected) {
        try { await cache.put(shellKey, response.clone()); } catch { /* Still serve live data if storage fills up. */ }
      }
      return response;
    } catch {
      return (await cache.match(shellKey)) || Response.error();
    }
  })());
});
