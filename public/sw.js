/* eslint-disable no-restricted-globals */
const CACHE_NAME = 'deriv-trader-pwa-v1.1.0';

const PRECACHE_ASSETS = [
  '/',
  '/offline',
  '/manifest.json',
  '/icon.svg',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/apple-touch-icon.png',
  '/smartcharts.css',
];

// Install Event: Pre-cache core shell resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[PWA Service Worker] Pre-cache error:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate Event: Clean up outdated caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[PWA Service Worker] Removing obsolete cache:', cacheName);
            return caches.delete(cacheName);
          }
          return null;
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event: Network & Cache Handling Strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignore non-GET requests or WebSocket connections
  if (request.method !== 'GET' || url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }

  // 1. Navigation Requests (Pages): Network-first with cache/offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseToCache));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            return caches.match('/offline');
          });
        })
    );
    return;
  }

  // 2. Static Assets (Scripts, Styles, Images, Fonts): Stale-while-revalidate
  if (
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.includes('/smartcharts') ||
    url.pathname.includes('/_next/static/')
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, responseToCache));
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 3. API Requests: Network-first with short-circuit error fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          return new Response(
            JSON.stringify({ error: 'OFFLINE_MODE', message: 'Offline mode active. Reconnect to fetch live data.' }),
            { headers: { 'Content-Type': 'application/json' }, status: 503 }
          );
        });
      })
    );
    return;
  }

  // Default fallback: Network fetch with cache fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// Listen for message events (e.g. SKIP_WAITING from client update prompt)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
