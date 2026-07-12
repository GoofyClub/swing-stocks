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
const LS_TRADES_KEY = 'swing.condorTrades';

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

function lsLoadTrades() {
  try { return JSON.parse(localStorage.getItem(LS_TRADES_KEY)) || []; } catch { return []; }
}
function lsSaveTrades(trades) {
  try { localStorage.setItem(LS_TRADES_KEY, JSON.stringify(trades)); } catch {}
}
function localTradeId() {
  return 'local-' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
function tradeSortKey(t) {
  const c = t.createdAt;
  if (c?.toDate) return c.toDate().getTime(); // Firestore Timestamp
  const n = new Date(c || 0).getTime();
  return Number.isFinite(n) ? n : 0;
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

// ----- Journal -----------------------------------------------------------
// Firestore when reachable + signed in; a localStorage fallback (ids
// prefixed "local-") whenever it isn't — no Firebase project configured,
// not signed in, or (most commonly) the Firestore security rules for
// /users/{uid}/condorTrades haven't been deployed yet, which surfaces as
// "Missing or insufficient permissions". Without this fallback that error
// hard-blocks LOG THIS TRADE; with it, trades logged during an outage just
// stay local until the underlying problem (usually an undeployed rules
// file — see the Desk Manual's setup step) is fixed.

export async function addCondorTrade(trade) {
  const record = { ...trade, status: trade.status || 'open' };
  const { db, ok } = initFirebase();
  if (ok) {
    const uid = await currentUid();
    if (uid) {
      try {
        const ref = await addDoc(collection(db, 'users', uid, 'condorTrades'),
          { ...record, createdAt: serverTimestamp() });
        return ref.id;
      } catch (e) {
        console.warn('[condor] log trade failed, saving locally instead', e.message);
      }
    }
  }
  const id = localTradeId();
  const trades = lsLoadTrades();
  trades.unshift({ id, ...record, createdAt: new Date().toISOString() });
  lsSaveTrades(trades);
  return id;
}

export async function listCondorTrades(max = 100) {
  const local = lsLoadTrades();
  const { db, ok } = initFirebase();
  if (!ok) return local.slice(0, max);
  const uid = await currentUid();
  if (!uid) return local.slice(0, max);
  try {
    const snap = await getDocs(query(
      collection(db, 'users', uid, 'condorTrades'),
      orderBy('createdAt', 'desc'), limit(max),
    ));
    const remote = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!local.length) return remote;
    return [...remote, ...local].sort((a, b) => tradeSortKey(b) - tradeSortKey(a)).slice(0, max);
  } catch (e) {
    console.warn('[condor] list trades failed, showing local copy', e.message);
    return local.slice(0, max);
  }
}

export async function updateCondorTrade(id, patch) {
  if (String(id).startsWith('local-')) {
    const trades = lsLoadTrades();
    const i = trades.findIndex(t => t.id === id);
    if (i === -1) throw new Error('Local trade not found.');
    trades[i] = { ...trades[i], ...patch, updatedAt: new Date().toISOString() };
    lsSaveTrades(trades);
    return;
  }
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  await updateDoc(doc(db, 'users', uid, 'condorTrades', id),
    { ...patch, updatedAt: serverTimestamp() });
}

export async function deleteCondorTrade(id) {
  if (String(id).startsWith('local-')) {
    lsSaveTrades(lsLoadTrades().filter(t => t.id !== id));
    return;
  }
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  await deleteDoc(doc(db, 'users', uid, 'condorTrades', id));
}
