// Notification-channel config (Telegram, etc.) at /users/{uid}/notifications/config.
// Read by the client (Settings page) and by the workers (via Admin SDK) to send
// trade entry/exit alerts.

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { initFirebase } from './firebase.js';

export const DEFAULT_NOTIFICATIONS = {
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
};

async function currentUid() {
  const auth = (await import('firebase/auth')).getAuth();
  return auth.currentUser?.uid || null;
}

export async function loadNotifications() {
  const { db, ok } = initFirebase();
  if (!ok) return { ...DEFAULT_NOTIFICATIONS };
  const uid = await currentUid();
  if (!uid) return { ...DEFAULT_NOTIFICATIONS };
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'notifications', 'config'));
    return snap.exists() ? { ...DEFAULT_NOTIFICATIONS, ...snap.data() } : { ...DEFAULT_NOTIFICATIONS };
  } catch (e) {
    console.warn('[notifications] load failed', e.message);
    return { ...DEFAULT_NOTIFICATIONS };
  }
}

export async function saveNotifications(cfg) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  await setDoc(doc(db, 'users', uid, 'notifications', 'config'), { ...cfg, updatedAt: serverTimestamp() }, { merge: true });
}
