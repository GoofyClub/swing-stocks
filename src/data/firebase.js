// =============================================================================
// Firebase initialization — Auth (Google) + Firestore with offline persistence.
// All config values come from Vite env vars (VITE_FIREBASE_*) and are safe to
// expose to the client. Real security is enforced by /firestore.rules.
// =============================================================================

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithRedirect,
  signInWithPopup,
  getRedirectResult,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore';

function readEnv(key, fallback = '') {
  const v = import.meta?.env?.[key];
  return (v === undefined || v === null) ? fallback : String(v);
}

export const firebaseConfig = {
  apiKey:            readEnv('VITE_FIREBASE_API_KEY'),
  authDomain:        readEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId:         readEnv('VITE_FIREBASE_PROJECT_ID'),
  storageBucket:     readEnv('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: readEnv('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId:             readEnv('VITE_FIREBASE_APP_ID'),
};

function configLooksValid(cfg) {
  return Boolean(cfg.apiKey && cfg.projectId && cfg.authDomain && cfg.appId);
}

let _app = null, _auth = null, _db = null, _provider = null;

export function initFirebase() {
  if (!configLooksValid(firebaseConfig)) {
    console.warn('[firebase] config incomplete — running in stub mode. Set VITE_FIREBASE_* env vars (see SETUP.md).');
    return { app: null, auth: null, db: null, ok: false };
  }
  if (_app) return { app: _app, auth: _auth, db: _db, ok: true };

  _app = initializeApp(firebaseConfig);
  _auth = getAuth(_app);

  // Persistent Firestore cache (IndexedDB) — survives page reloads + tab close.
  // The multi-tab manager keeps cache consistent if user opens the app in 2 tabs.
  try {
    _db = initializeFirestore(_app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn('[firebase] persistent cache failed — likely browser blocks IndexedDB. Falling back to in-memory.', e);
    _db = initializeFirestore(_app, {});
  }

  _provider = new GoogleAuthProvider();
  _provider.setCustomParameters({ prompt: 'select_account' });

  return { app: _app, auth: _auth, db: _db, ok: true };
}

// Use popup on desktop where it's faster; fall back to redirect on mobile where popups are blocked.
function shouldUsePopup() {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  return !isMobile;
}

export async function signIn() {
  const { auth, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured. See SETUP.md.');
  if (shouldUsePopup()) {
    try {
      return await signInWithPopup(auth, _provider);
    } catch (e) {
      // Common failure modes on desktop: popup blocked, third-party-cookies blocked.
      // Fall through to redirect.
      console.warn('[auth] popup sign-in failed — falling back to redirect:', e.code || e.message);
      return signInWithRedirect(auth, _provider);
    }
  }
  return signInWithRedirect(auth, _provider);
}

export async function completeRedirectIfAny() {
  const { auth, ok } = initFirebase();
  if (!ok) return null;
  try {
    return await getRedirectResult(auth);
  } catch (e) {
    console.error('[auth] redirect completion failed', e);
    return null;
  }
}

export async function signOut() {
  const { auth, ok } = initFirebase();
  if (!ok) return;
  await fbSignOut(auth);
}

export function onUser(cb) {
  const { auth, ok } = initFirebase();
  if (!ok) { cb(null); return () => {}; }
  return onAuthStateChanged(auth, cb);
}

// -----------------------------------------------------------------------------
// User-doc bootstrap: ensure /users/{uid} exists with sensible defaults on first
// sign-in. Idempotent.
// -----------------------------------------------------------------------------
export async function ensureUserDoc(user) {
  if (!user) return;
  const { db, ok } = initFirebase();
  if (!ok) return;
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    email:       user.email || null,
    displayName: user.displayName || null,
    photoURL:    user.photoURL || null,
    createdAt:   serverTimestamp(),
    prefs: {
      theme:           'dark',
      fontSize:        'M',
      market:          'US',
      dataSourceOpen:  false,
      collapsedPanels: {},
    },
  });
}

// Re-export the Firestore helpers our views need so callers don't import deep paths.
export {
  collection, doc, getDoc, setDoc, serverTimestamp,
};
