// =============================================================================
// Firebase Cloud Messaging — client wrapper.
//
// Wires up:
//   - Service worker registration (public/firebase-messaging-sw.js)
//   - Permission prompt + token retrieval (VAPID-secured)
//   - Persisting tokens to /users/{uid}/fcmTokens/{token}
//   - Foreground in-app notifications via the FCM SDK's onMessage()
//
// The cron worker (scripts/refresh-signals.mjs) sends actual pushes using the
// Admin SDK — see notifyUser() there.
// =============================================================================

import { getMessaging, getToken, onMessage, isSupported, deleteToken } from 'firebase/messaging';
import { initFirebase, firebaseConfig, doc, setDoc, deleteDoc, serverTimestamp, collection, getDocs } from './firebase.js';
import { state } from '../core/state.js';

let _messaging = null;
let _swReg = null;

export async function isFCMSupported() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    if (!('Notification' in window)) return false;
    return await isSupported();
  } catch { return false; }
}

function vapidKey() {
  return import.meta.env.VITE_FIREBASE_VAPID_KEY || '';
}

// Get the base path Vite was built against ('/swing-stocks/' in prod, '/' in dev).
// The SW must register at the app's base scope so notifications click into the right URL.
function basePath() {
  return import.meta.env.BASE_URL || '/';
}

// Register the SW with the Firebase config encoded in query params, so the SW
// can initialise itself even though it can't read Vite env vars.
async function registerSW() {
  if (_swReg) return _swReg;
  if (!('serviceWorker' in navigator)) return null;
  const params = new URLSearchParams({
    apiKey:            firebaseConfig.apiKey,
    authDomain:        firebaseConfig.authDomain,
    projectId:         firebaseConfig.projectId,
    messagingSenderId: firebaseConfig.messagingSenderId,
    appId:             firebaseConfig.appId,
  });
  const url = `${basePath()}firebase-messaging-sw.js?${params.toString()}`;
  try {
    _swReg = await navigator.serviceWorker.register(url, { scope: basePath() });
  } catch (e) {
    console.error('[fcm] SW registration failed', e);
    throw e;
  }
  return _swReg;
}

export async function initFCM() {
  if (_messaging) return _messaging;
  if (!(await isFCMSupported())) return null;
  const { app, ok } = initFirebase();
  if (!ok) return null;
  _messaging = getMessaging(app);
  return _messaging;
}

// Full enable flow: registers SW, prompts permission, fetches token, persists to
// Firestore. Returns the token string. Throws with a friendly message on each
// failure mode so callers can surface it.
export async function enableNotifications(user) {
  if (!user) throw new Error('Sign in required.');
  if (!vapidKey()) {
    throw new Error('Push notifications are not configured for this deployment. The admin needs to set VITE_FIREBASE_VAPID_KEY (see SETUP.md → Notifications).');
  }
  if (!(await isFCMSupported())) {
    throw new Error('This browser does not support push notifications.');
  }
  const swReg = await registerSW();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(`Permission ${permission}. Open browser site settings and allow notifications, then try again.`);
  }
  const messaging = await initFCM();
  if (!messaging) throw new Error('Could not initialize messaging.');
  const token = await getToken(messaging, { vapidKey: vapidKey(), serviceWorkerRegistration: swReg });
  if (!token) throw new Error('FCM did not return a token.');

  const { db } = initFirebase();
  await setDoc(doc(db, 'users', user.uid, 'fcmTokens', token), {
    token,
    createdAt:  serverTimestamp(),
    userAgent:  (navigator.userAgent || '').slice(0, 200),
    market:     state.market,
  }, { merge: true });

  return token;
}

// Best-effort unsubscribe: deletes the local FCM token and removes it from
// Firestore. The remote token doc lives under /users/{uid}/fcmTokens.
export async function disableNotifications(user) {
  if (!user) return;
  try {
    const messaging = await initFCM();
    if (messaging) {
      try {
        const token = await getToken(messaging, { vapidKey: vapidKey(), serviceWorkerRegistration: _swReg || (await registerSW()) });
        if (token) {
          try { await deleteToken(messaging); } catch {}
          const { db } = initFirebase();
          try { await deleteDoc(doc(db, 'users', user.uid, 'fcmTokens', token)); } catch {}
        }
      } catch {}
    }
    // Clean up any other stored tokens for this device (best effort).
    const { db } = initFirebase();
    const ua = (navigator.userAgent || '').slice(0, 200);
    const all = await getDocs(collection(db, 'users', user.uid, 'fcmTokens'));
    for (const d of all.docs) {
      if (d.data().userAgent === ua) {
        try { await deleteDoc(d.ref); } catch {}
      }
    }
  } catch (e) {
    console.warn('[fcm] disable failed', e);
  }
}

// Has THIS user/device already been registered? Used by Settings to choose
// between "Enable notifications" and "Disable notifications" labels.
export async function isCurrentDeviceRegistered(user) {
  if (!user) return false;
  if (!(await isFCMSupported())) return false;
  try {
    const messaging = await initFCM();
    if (!messaging) return false;
    const swReg = await registerSW();
    const token = await getToken(messaging, { vapidKey: vapidKey(), serviceWorkerRegistration: swReg }).catch(() => null);
    if (!token) return false;
    const { db } = initFirebase();
    const all = await getDocs(collection(db, 'users', user.uid, 'fcmTokens'));
    return all.docs.some(d => d.id === token);
  } catch { return false; }
}

// Foreground message hook — fires when a push arrives while the tab is focused
// (background pushes are handled by the SW). Use this to show an in-app toast
// so the user gets feedback even when notifications are silenced by the OS.
export async function onForegroundMessage(cb) {
  const messaging = await initFCM();
  if (!messaging) return () => {};
  return onMessage(messaging, cb);
}
