// Service worker : rend l'appli installable et utilisable hors connexion.
// Si tu modifies index.html ou app.js, change le numéro de version pour forcer la mise à jour.
const VERSION = 'rugby-v5';
const COQUE = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/fond.webp'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(COQUE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Notification envoyée par le serveur (même appli fermée) : on l'affiche.
// Le "tag" fait que chaque nouvelle notification remplace la précédente : une seule notification qui se met à jour.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Rugby en direct', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Rugby en direct', {
    body: d.body || '',
    tag: d.tag || 'rugby-live',
    icon: '/icon-192.png',
    silent: !!d.silent,
    renotify: !!d.renotify && !d.silent,
    requireInteraction: !!d.requireInteraction,
    data: { url: d.url || '/' },
  }));
});

// Un appui sur la notification ouvre (ou ramène au premier plan) l'appli.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(fenetres => {
    const ouverte = fenetres.find(c => 'focus' in c);
    return ouverte ? ouverte.focus() : self.clients.openWindow((e.notification.data && e.notification.data.url) || '/');
  }));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Données : le réseau d'abord (pour avoir du frais), la dernière copie en secours.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { if (r.ok) { const copie = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copie)); } return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // Fichiers de l'appli : le cache d'abord (démarrage instantané).
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
