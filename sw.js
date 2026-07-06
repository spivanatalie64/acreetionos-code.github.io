// Service Worker for aggressive caching and offline support
// Intercepts /api/chat and forwards to OpenRouter
const CACHE_VERSION = 'v2';
const CACHE_NAME = `acreetionos-${CACHE_VERSION}`;

#  removed
const CHECK_INTERVAL = 5 * 60 * 1000;

// NOTE: Do NOT store API keys here. The Service Worker will proxy /api/chat
// to the site's backend (Cloudflare Worker or origin) which holds the key
// securely in server-side environment variables. This prevents exposing
// secrets to the browser or in client-side code.

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/contact.html',
  '/selfhelp.html',
  '/docs.html',
  '/contact.css',
  '/contact.js',
  '/acreetionoslogo.webp',
  '/logo.webp',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
  scheduleAidenCheck();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
  scheduleAidenCheck();
});

// Fetch event - serve from cache, forward API requests directly
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass service worker for Cloudflare edge endpoints (Zaraz, RUM, etc.)
  if (url.pathname.startsWith('/cdn-cgi/')) {
    return;
  }

  // Forward all POST API requests directly without caching
  if (event.request.method === 'POST' && url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request.clone()));
    return;
  }

  // Only cache GET requests
  if (event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Normal caching for GET requests
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }
      return fetch(event.request).then((response) => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      });
    })
  );
});

// The Service Worker no longer performs OpenRouter requests itself. Requests
// to /api/chat are forwarded to the origin/Cloudflare Worker where the
// OpenRouter API key is stored in a server-side environment variable.
// This function is kept for historical reasons but is no longer used.
async function handleAidenFallback() {
  return new Response(JSON.stringify({ error: 'Service Worker fallback disabled' }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' }
  });
}

let checkTimer = null;

function scheduleAidenCheck() {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(checkAidenOnline, 30000);
}

async function checkAidenOnline() {
  try {
    const response = await fetch(_URL, { 
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store'
    });
    await notifySubscribers(true);
  } catch (e) {
  }
  scheduleAidenCheck();
}

async function notifySubscribers(isOnline) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  
  for (const client of clients) {
    client.postMessage({
      type: '_STATUS',
      online: isOnline
    });
  }
}

// Listen for messages from pages
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
