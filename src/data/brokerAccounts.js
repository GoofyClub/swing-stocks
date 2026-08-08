// =============================================================================
// brokerAccounts.js — several broker accounts per user, for the Performance tab.
//
// The Automation page holds ONE account, because the trader can only trade one.
// Performance is different: you want to compare accounts, so this stores a list
// at /users/{uid}/brokerAccounts/{id}.
//
// The automation account is surfaced as a read-only entry (id 'automation') so
// it appears in the switcher without being duplicated — edit it where it lives,
// on the Automation page, and there is only ever one copy of those credentials.
//
// SECURITY: these documents hold API keys. Firestore rules restrict them to the
// owner. Alpaca keys cannot move money out of an account, which bounds the
// damage, but they can read positions and place trades — so prefer keys with the
// narrowest permissions the broker offers, and use PAPER keys for anything you
// only want to look at.
// =============================================================================

import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { initFirebase } from './firebase.js';

const AUTOMATION_ID = 'automation';

async function currentUid() {
  const auth = (await import('firebase/auth')).getAuth();
  return auth.currentUser?.uid || null;
}

function isLive(baseUrl) {
  return !!baseUrl && !/paper-api/i.test(baseUrl);
}

// All accounts available to the switcher: the automation account first (so the
// default view is the one that actually trades), then any added here.
export async function listBrokerAccounts() {
  const { db, ok } = initFirebase();
  if (!ok) return [];
  const uid = await currentUid();
  if (!uid) return [];

  const out = [];
  try {
    const autoSnap = await getDoc(doc(db, 'users', uid, 'automation', 'config'));
    if (autoSnap.exists()) {
      const a = autoSnap.data();
      if (a.apiKey && a.apiSecret) {
        out.push({
          id: AUTOMATION_ID,
          label: a.label || 'Automation account',
          apiKey: a.apiKey,
          apiSecret: a.apiSecret,
          baseUrl: a.restApiBase || 'https://paper-api.alpaca.markets',
          live: isLive(a.restApiBase),
          readOnly: true,   // edited on the Automation page, not here
        });
      }
    }
  } catch { /* automation account is optional */ }

  try {
    const snap = await getDocs(collection(db, 'users', uid, 'brokerAccounts'));
    snap.forEach(d => {
      const v = d.data();
      if (!v.apiKey || !v.apiSecret) return;
      out.push({
        id: d.id,
        label: v.label || d.id,
        apiKey: v.apiKey,
        apiSecret: v.apiSecret,
        baseUrl: v.baseUrl || 'https://paper-api.alpaca.markets',
        live: isLive(v.baseUrl),
        readOnly: false,
      });
    });
  } catch (e) { console.warn('[brokerAccounts] list failed', e.message); }

  return out;
}

export async function saveBrokerAccount({ id, label, apiKey, apiSecret, baseUrl }) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  if (id === AUTOMATION_ID) throw new Error('Edit the automation account on the Automation page.');
  if (!label?.trim()) throw new Error('A label is required.');
  if (!apiKey?.trim() || !apiSecret?.trim()) throw new Error('API key and secret are required.');

  // Deterministic id from the label so re-saving edits rather than duplicating.
  const docId = id || label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || `acct-${Date.now()}`;
  await setDoc(doc(db, 'users', uid, 'brokerAccounts', docId), {
    label: label.trim(),
    apiKey: apiKey.trim(),
    apiSecret: apiSecret.trim(),
    baseUrl: (baseUrl || 'https://paper-api.alpaca.markets').trim(),
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return docId;
}

export async function deleteBrokerAccount(id) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  if (id === AUTOMATION_ID) throw new Error('The automation account is managed on the Automation page.');
  await deleteDoc(doc(db, 'users', uid, 'brokerAccounts', id));
}

export { AUTOMATION_ID };
