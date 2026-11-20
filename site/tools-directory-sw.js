'use strict';
const CACHE_PREFIX = 'fgs-tools-directory-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-20-mobile-v2';
const NAVIGATION_PATHS = new Set(['/tools', '/tools.html']);
const SHELL = ['/tools', '/assets/site.css', '/assets/tools.css', '/assets/service.js',
  '/assets/tool-install-v1.js', '/assets/tool-install-v1.css', '/tools-directory.webmanifest',
  '/assets/brand/website/fgs-brand-v3.css', '/assets/brand/website/site-brand-v4.css',
  '/assets/brand/fonts/Nunito-Variable.woff2',
  '/assets/brand/logos/FGS-Logo-Green-Mobile-613.webp', '/assets/brand/logos/FGS-Logo-Green-Transparent-v3.png', '/assets/brand/logos/FGS-Logo-White-Transparent-v4.png',
  '/assets/brand/icons/FGS-JF-Leaf-Green-v3.svg', '/assets/brand/icons/FGS-JF-Leaf-192-v3.png', '/assets/brand/icons/FGS-JF-Leaf-512-v3.png',
  '/favicon-v5.ico', '/favicon-v5.svg', '/favicon-v5-32.png', '/replay/icons/icon.svg', '/assets/room-measure.svg'];
const ALLOWED = new Set(SHELL);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = request.mode === 'navigate';
  if (navigation && !NAVIGATION_PATHS.has(url.pathname)) return;
  const key = navigation ? '/tools' : url.pathname;
  if (!ALLOWED.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(key, response.clone());
      return response;
    } catch { return (await cache.match(key)) || Response.error(); }
  })());
});
