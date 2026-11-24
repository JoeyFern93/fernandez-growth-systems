'use strict';
const CACHE_PREFIX = 'fgs-replay-';
const CACHE_NAME = CACHE_PREFIX + 'v14-aeaada30c456';
const APP_SHELL = [
  './tv/quality.js?v=df1580f4c305', './tv/quality.css?v=eb51917b3520',
  './', './css/app-v10.css?v=1691ba92efd2', './css/dashboard-v11.css?v=bb7adb4edd7a', './js/dashboard-v11.js?v=4b4ca30c573a',
  './js/frame-times-v1.js?v=2d651db02d37', './js/frame-export-v1.js?v=ff4b11081252', './js/app-v11.js?v=62e36761733c', './js/replay-ui.js?v=5994a7be705f',
  './tv/pair.js?v=d7f6185a96d1', './tv/relay-media.js?v=5c2d3db6276c', './tv/pair.css?v=7a29e5dfe7ee', './manifest-v3.webmanifest', './js/install-v4.js?v=32944f14ecd6',
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
