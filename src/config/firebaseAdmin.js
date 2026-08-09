// =============================================================================
// firebaseAdmin.js — one Firestore Admin initialiser for every Node entrypoint.
//
// Credential resolution, in order:
//   1. FIREBASE_SERVICE_ACCOUNT_FILE — path to the key JSON. Preferred over
//      pasting the key inline: systemd's EnvironmentFile is not a shell and
//      mangles the quotes in the blob, which surfaces as a JSON.parse failure at
//      run time rather than at setup.
//   2. FIREBASE_SERVICE_ACCOUNT_JSON — raw JSON. What CI uses (GitHub Secrets).
//   3. Application Default Credentials — nothing configured. On GCE this is the
//      VM's attached service account from the metadata server: no key on disk to
//      leak or rotate, and the only option when an org enforces
//      iam.disableServiceAccountKeyCreation.
//
// For (3) the VM's service account needs roles/datastore.user ON THE FIREBASE
// PROJECT (often not the project the VM lives in) and the cloud-platform scope.
// =============================================================================

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { configErrorHint } from './configHint.js';

export function initFirestore({ log = () => {} } = {}) {
  if (admin.apps.length) return admin.firestore();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error(configErrorHint('FIREBASE_PROJECT_ID'));

  const saFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const saJson = saFile ? readFileSync(saFile, 'utf8') : process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (saJson) {
    let creds;
    try { creds = JSON.parse(saJson); }
    catch (e) {
      throw new Error(`service account key is not valid JSON (${saFile ? `file ${saFile}` : 'FIREBASE_SERVICE_ACCOUNT_JSON'}): ${e.message}`);
    }
    admin.initializeApp({ credential: admin.credential.cert(creds), projectId });
  } else {
    log('no service-account key configured — using Application Default Credentials (GCE attached service account)');
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
  }
  return admin.firestore();
}

export { admin };
