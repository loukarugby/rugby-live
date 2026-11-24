// Service worker : rend l'appli installable et utilisable hors connexion.
// Si tu modifies index.html ou app.js, change le numéro de version pour forcer la mise à jour.
const VERSION = 'rugby-v1';
const COQUE = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

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

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Données : le réseau d'abord (pour avoir du frais), la dernière copie en secours.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const copie = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copie)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // Fichiers de l'appli : le cache d'abord (démarrage instantané).
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
