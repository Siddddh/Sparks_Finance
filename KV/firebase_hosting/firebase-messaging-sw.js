/* firebase-messaging-sw.js — service worker for Sparks Finance.
 *
 * Does TWO jobs from one worker (registered at the hosting root, scope "/"):
 *   1. PWA app-shell caching → installability + offline shell.
 *   2. FCM background push → notifications when the app tab is closed.
 *
 * Uses the same Firebase 10.12.0 compat SDK as index.html.
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ── App-shell caching (PWA) ─────────────────────────────────────────────────
const CACHE = 'sparks-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/symbols.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/favicon.ico'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individual addAll can fail the whole install if one URL 404s; be lenient.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle our own origin. Cross-origin (Firestore/googleapis, gstatic,
  // fonts, Yahoo quotes…) passes straight to the network so live data and the
  // Firebase SDKs are never intercepted.
  if (url.origin !== self.location.origin) return;

  // Navigations → network-first, fall back to the cached app shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Other same-origin assets → cache-first, then network (and cache the result).
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      });
    })
  );
});

// ── FCM background push ──────────────────────────────────────────────────────
firebase.initializeApp({
  apiKey: 'AIzaSyBHpfvSqmWQw1Ka5mVkvKFsW9Vvf3hyCJg',
  authDomain: 'claude-apps-a6fe1.firebaseapp.com',
  projectId: 'claude-apps-a6fe1',
  storageBucket: 'claude-apps-a6fe1.firebasestorage.app',
  messagingSenderId: '587653358402',
  appId: '1:587653358402:web:6e1e468ab773f642d69edb'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function (payload) {
  const n = (payload && payload.notification) || {};
  const d = (payload && payload.data) || {};
  const title = n.title || d.title || 'Sparks Finance — Pre-Market';
  const options = {
    body: n.body || d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'premarket-digest',
    data: { url: '/' }
  };
  return self.registration.showNotification(title, options);
});

// Focus/open the app when the user clicks the notification.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
