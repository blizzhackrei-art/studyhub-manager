const CACHE_NAME = 'studyhub-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/printer.js',
  '/db.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Skip Firebase and Google API requests — let them go through normally
  const url = e.request.url;
  if (url.includes('firebaseio.com') || url.includes('googleapis.com') || url.includes('gstatic.com/firebasejs')) {
    return; // don't intercept, let network handle
  }

  e.respondWith(
    caches.match(e.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(e.request)
          .then(response => {
            // Cache successful GET requests
            if (e.request.method === 'GET' && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
            }
            return response;
          })
          .catch(() => caches.match('/index.html'));
      })
  );
});
