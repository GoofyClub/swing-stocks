// =============================================================================
// Per-user watchlist Firestore helpers.
// Path: /users/{uid}/watchlist/{ticker}
//
// One doc per ticker. Doc ID = ticker so add/remove are idempotent and there
// is no risk of duplicates.
// =============================================================================

import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, orderBy,
  serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { initFirebase } from './firebase.js';
import {
  STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA, companyName, MARKET_CONFIGS, nameForTicker,
} from './markets.js';

async function requireUser() {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const auth = (await import('firebase/auth')).getAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  return { db, user };
}

export async function loadWatchlist(market) {
  try {
    const { db, user } = await requireUser();
    const ref = collection(db, 'users', user.uid, 'watchlist');
    const snap = await getDocs(query(ref, orderBy('addedAt', 'desc')));
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (market) return all.filter(w => !w.market || w.market === market);
    return all;
  } catch (e) {
    console.warn('[watchlist] load failed', e.message);
    return [];
  }
}

export async function addToWatchlist({ ticker, sector, notes, market }) {
  const cleanTicker = (ticker || '').trim().toUpperCase();
  if (!cleanTicker) throw new Error('Ticker is required.');
  if (!/^[\^A-Z0-9._\-]+$/i.test(cleanTicker)) throw new Error('Ticker contains invalid characters.');
  const { db, user } = await requireUser();
  const ref = doc(db, 'users', user.uid, 'watchlist', cleanTicker);
  // Don't overwrite addedAt if the doc already exists (preserve history).
  const existing = await getDoc(ref);
  await setDoc(ref, {
    ticker: cleanTicker,
    name:   nameForTicker(cleanTicker) || cleanTicker,
    sector: sector || null,
    notes:  (notes || '').slice(0, 500),
    market: market || null,
    addedAt: existing.exists() ? (existing.data().addedAt || serverTimestamp()) : serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return cleanTicker;
}

export async function removeFromWatchlist(ticker) {
  const { db, user } = await requireUser();
  await deleteDoc(doc(db, 'users', user.uid, 'watchlist', ticker));
}

export async function updateWatchlistNotes(ticker, notes) {
  const { db, user } = await requireUser();
  await setDoc(doc(db, 'users', user.uid, 'watchlist', ticker), {
    notes: (notes || '').slice(0, 500),
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

// One-shot bootstrap: load the curated starter list for the user's current market.
// Uses a single batched write to stay within Firestore quotas (1 write per ticker).
export async function importStarterWatchlist(market) {
  const list = market === 'INDIA' ? STARTER_WATCHLIST_INDIA : STARTER_WATCHLIST;
  if (!Array.isArray(list) || list.length === 0) return 0;
  const { db, user } = await requireUser();
  const batch = writeBatch(db);
  for (const item of list) {
    const ref = doc(db, 'users', user.uid, 'watchlist', item.t);
    batch.set(ref, {
      ticker: item.t,
      name:   companyName(item),
      sector: item.s || null,
      notes:  item.why || '',
      market: market || null,
      addedAt:   serverTimestamp(),
      updatedAt: serverTimestamp(),
      importedFromStarter: true,
    }, { merge: true });
  }
  await batch.commit();
  return list.length;
}

// Convenience: for a given market, returns the sectors known to the config.
export function sectorOptionsForMarket(market) {
  const cfg = MARKET_CONFIGS[market];
  if (!cfg?.sectorNames) return [];
  return Object.entries(cfg.sectorNames).map(([code, name]) => ({ code, name }));
}
