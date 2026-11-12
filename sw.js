/* Service worker: keeps the app files on the phone so the app opens instantly.
   Strategy: show the saved copy at once, fetch a fresh copy in the background
   (the new version appears the next time the app opens). Server data and
   photos are not handled here. Change VERSION when releasing new files. */
var VERSION = 'unit-v1';
var FILES = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-180.png', './icon-192.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // API and photos go straight to the network
  var key = req.mode === 'navigate' ? './index.html' : req;   // any ?k=... link opens the same page
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(key, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) c.put(key, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
