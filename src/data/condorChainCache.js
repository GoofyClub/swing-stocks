// Condor Desk chain cache — remembers the last successfully fetched option
// chain (+ VIX) per underlying+mode in localStorage, so re-opening the tab or
// re-clicking GET TODAY'S LEGS doesn't re-hit CBOE/Alpaca every time. A cache
// entry is only valid for the SAME US-Eastern calendar day it was fetched —
// options reprice every session, so yesterday's (or last week's) chain must
// never be reused silently.
//
// `storage` is injectable (defaults to the browser's localStorage) purely so
// tests/condor.mjs can exercise this in Node with an in-memory fake.

import { etNow } from './condor.js';

const NS = 'swing.condorChain.v1';

function keyFor(underlying, mode) {
  return `${NS}.${underlying}.${mode}`;
}

// Persist a successful fetch. `chain` must already carry `fetchedAt` (set by
// fetchChainSmart); `vix` may be null if that call failed.
export function saveChainCache(underlying, mode, chain, vix, storage = globalThis.localStorage) {
  if (!storage || !chain?.fetchedAt) return;
  try {
    storage.setItem(keyFor(underlying, mode), JSON.stringify({ chain, vix }));
  } catch { /* storage full/unavailable — caching is a convenience, never fatal */ }
}

// Returns { chain, vix } if a same-ET-day cache entry exists, else null.
export function loadChainCache(underlying, mode, now = new Date(), storage = globalThis.localStorage) {
  if (!storage) return null;
  let raw;
  try { raw = storage.getItem(keyFor(underlying, mode)); } catch { return null; }
  if (!raw) return null;
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  const fetchedAt = payload?.chain?.fetchedAt;
  if (!fetchedAt || !payload.chain?.options?.length) return null;
  const fetchedDayET = etNow(new Date(fetchedAt)).iso;
  const todayET = etNow(now).iso;
  if (fetchedDayET !== todayET) return null; // stale — different trading day
  return { chain: payload.chain, vix: Number.isFinite(payload.vix) ? payload.vix : null };
}

export function clearChainCache(underlying, mode, storage = globalThis.localStorage) {
  if (!storage) return;
  try { storage.removeItem(keyFor(underlying, mode)); } catch { /* noop */ }
}
