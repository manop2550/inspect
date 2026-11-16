/* Owner app service worker: keeps the app files on the phone so it opens instantly.
   Saved copy first, fresh copy fetched in the background. Change VERSION on each release. */
var VERSION = 'owner-v2';
var FILES = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-180.png', './icon-192.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('owner-') === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(key, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
      var net = fetch(req).then(function (res) { if (res && res.ok) c.put(key, res.clone()); return res; })
        .catch(function () { return hit; });
      return hit || net;
    });
  }));
});
