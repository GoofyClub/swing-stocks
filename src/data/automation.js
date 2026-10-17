// =============================================================================
// Automation config — per-user rules that a (future) execution worker will use
// to place broker orders from matching signals. This module only persists the
// config to /users/{uid}/automation/config; it never places orders itself.
//
// ⚠️ SAFETY: `enabled` defaults to false and `mode` defaults to 'paper'. Nothing
// here connects to a broker — the settings page is config-only until the
// server-side execution worker ships (see the Automation guide).
// =============================================================================

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { initFirebase } from './firebase.js';

// Single source of truth for defaults. Every field the settings page edits must
// exist here so load() can fill gaps for users whose doc predates a new field.
import { DEFAULT_AUTOMATION } from '../config/automation-defaults.js';
export { DEFAULT_AUTOMATION };

function configRef(db, uid) {
  return doc(db, 'users', uid, 'automation', 'config');
}

async function currentUid() {
  const auth = (await import('firebase/auth')).getAuth();
  return auth.currentUser?.uid || null;
}

// Reads the user's config, merged over defaults so missing fields are filled.
export async function loadAutomationConfig() {
  const { db, ok } = initFirebase();
  if (!ok) return { ...DEFAULT_AUTOMATION };
  const uid = await currentUid();
  if (!uid) return { ...DEFAULT_AUTOMATION };
  try {
    const snap = await getDoc(configRef(db, uid));
    if (!snap.exists()) return { ...DEFAULT_AUTOMATION };
    return { ...DEFAULT_AUTOMATION, ...snap.data() };
  } catch (e) {
    console.warn('[automation] load failed', e.message);
    return { ...DEFAULT_AUTOMATION };
  }
}

// Persists a full config object (merge:true so we never drop unknown fields a
// newer client may have written).
export async function saveAutomationConfig(cfg) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  const clean = { ...cfg, updatedAt: serverTimestamp() };
  await setDoc(configRef(db, uid), clean, { merge: true });
}
