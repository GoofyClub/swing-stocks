// Condor Desk persistence.
//   /users/{uid}/condor/config        — active config + named presets
//   /users/{uid}/condorTrades/{id}    — journal of placed condors
// Firestore when signed in; localStorage fallback so the calculator still
// remembers settings if Firestore is unreachable.

import {
  doc, getDoc, setDoc, collection, addDoc, getDocs, query, orderBy, limit,
  updateDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import { initFirebase } from './firebase.js';
import { DEFAULT_CONDOR_CONFIG } from './condor.js';

const LS_KEY = 'swing.condor';

async function currentUid() {
  const auth = (await import('firebase/auth')).getAuth();
  return auth.currentUser?.uid || null;
}

function lsLoad() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
}
function lsSave(state) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

// → { config, presets: { name: config } }
export async function loadCondorState() {
  const fallback = lsLoad() || {};
  const base = {
    config: { ...DEFAULT_CONDOR_CONFIG, ...(fallback.config || {}) },
    presets: fallback.presets || {},
  };
  const { db, ok } = initFirebase();
  if (!ok) return base;
  const uid = await currentUid();
  if (!uid) return base;
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'condor', 'config'));
    if (!snap.exists()) return base;
    const d = snap.data();
    return {
      config: { ...DEFAULT_CONDOR_CONFIG, ...(d.config || {}) },
      presets: d.presets || {},
    };
  } catch (e) {
    console.warn('[condor] load config failed, using local copy', e.message);
    return base;
  }
}

export async function saveCondorState(state) {
  lsSave(state); // always keep the local copy fresh
  const { db, ok } = initFirebase();
  if (!ok) return;
  const uid = await currentUid();
  if (!uid) return;
  await setDoc(doc(db, 'users', uid, 'condor', 'config'),
    { ...state, updatedAt: serverTimestamp() }, { merge: true });
}

// ----- Journal ---------------------------------------------------------------

export async function addCondorTrade(trade) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  const ref = await addDoc(collection(db, 'users', uid, 'condorTrades'), {
    ...trade, status: trade.status || 'open', createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function listCondorTrades(max = 100) {
  const { db, ok } = initFirebase();
  if (!ok) return [];
  const uid = await currentUid();
  if (!uid) return [];
  try {
    const snap = await getDocs(query(
      collection(db, 'users', uid, 'condorTrades'),
      orderBy('createdAt', 'desc'), limit(max),
    ));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[condor] list trades failed', e.message);
    return [];
  }
}

export async function updateCondorTrade(id, patch) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  await updateDoc(doc(db, 'users', uid, 'condorTrades', id),
    { ...patch, updatedAt: serverTimestamp() });
}

export async function deleteCondorTrade(id) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  await deleteDoc(doc(db, 'users', uid, 'condorTrades', id));
}
