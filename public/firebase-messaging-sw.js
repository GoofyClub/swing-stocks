// =============================================================================
// Firebase Cloud Messaging service worker.
//
// Lives at the build's root (copied verbatim from /public/) so its scope covers
// the whole app. When the page registers it (see src/data/messaging.js), it
// passes the Firebase config as URL query params — service workers can't read
// Vite env vars at runtime.
//
// Receives background pushes from Admin SDK (sent by the cron worker when a
// trade closes) and surfaces them as native browser notifications.
// =============================================================================

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const params = new URLSearchParams(self.location.search);
const cfg = {
  apiKey:            params.get('apiKey')            || '',
  authDomain:        params.get('authDomain')        || '',
  projectId:         params.get('projectId')         || '',
  messagingSenderId: params.get('messagingSenderId') || '',
  appId:             params.get('appId')             || '',
};

if (!cfg.apiKey || !cfg.projectId) {
  console.warn('[fcm-sw] Firebase config missing in registration URL — notifications disabled.');
} else {
  firebase.initializeApp(cfg);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const n = payload.notification || {};
    const data = payload.data || {};
    self.registration.showNotification(n.title || 'Swing Terminal', {
      body:  n.body  || '',
      icon:  n.icon  || undefined,
      badge: n.badge || undefined,
      tag:   data.tradeId || undefined,
      data:  { link: data.link || '/' },
    });
  });
}

// When the user clicks a notification, focus an existing tab or open a new one
// at the deep link the payload supplied.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(link) && 'focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(link);
  })());
});
