'use strict';
const CACHE_PREFIX = 'fgs-studio-replay-';
const CACHE_NAME = CACHE_PREFIX + 'v1-a138e34df5db';
const APP_SHELL = [
  './tv/quality.js?v=6f2a107c63c5', './tv/quality.css?v=eb51917b3520',
  './', './css/app-v10.css?v=16745283f035', './css/dashboard-v11.css?v=56e78b7ca374', './js/dashboard-v11.js?v=0a590ab9277a',
  './js/frame-times-v1.js?v=2d651db02d37', './js/frame-export-v1.js?v=07b6b1a13a68', './js/app-v11.js?v=898b2be56147', './js/replay-ui.js?v=5994a7be705f',
  './tv/pair.js?v=dd617a821d2b', './tv/relay-media.js?v=517561d29f42', './tv/pair.css?v=7a29e5dfe7ee', './manifest.webmanifest', './js/install-v4.js?v=bb7d2d97f6eb',
  '../favicon-v5.ico', '../favicon-v5.svg', '../favicon-v5-32.png', '../assets/tool-install-v1.css?v=4122f70c207f',
  '../assets/brand/website/fgs-brand-v3.css?v=8832ab1a9e06', '../assets/brand/replay-brand-v3.css?v=465557656770',
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
  // must reach their own server route. Never substitute the Replay Studio shell.
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
