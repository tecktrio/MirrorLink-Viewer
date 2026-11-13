// Self-unregistering Service Worker for Smart TV memory optimization
self.addEventListener('install', function (e) {
    self.skipWaiting();
});

self.addEventListener('activate', function (e) {
    self.registration.unregister().then(function () {
        console.log("ServiceWorker unregistered for Smart TV memory optimization.");
    });
});
