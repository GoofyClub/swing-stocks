// Cron Status — execution history of the "Refresh shared signals" worker, read
// from /cronRuns (written by scripts/refresh-signals.mjs each run).

import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { initFirebase } from '../data/firebase.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTs(ts) {
  if (!ts) return '—';
  try { return (ts.toDate ? ts.toDate() : new Date(ts)).toLocaleString(); } catch { return '—'; }
}
function ago(ts) {
  if (!ts?.toDate) return '';
  const mins = Math.round((Date.now() - ts.toDate().getTime()) / 60000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

async function loadRuns() {
  const { db, ok } = initFirebase();
  if (!ok) return { runs: [], err: 'Firebase not configured.' };
  try {
    const q = query(collection(db, 'cronRuns'), orderBy('createdAt', 'desc'), limit(50));
    const snap = await getDocs(q);
    return { runs: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  } catch (e) {
    return { runs: [], err: e.message };
  }
}

export async function renderCronStatus(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Execution Status</h1>
      <p class="subtitle">Execution history of the scheduled workers — <b>Refresh shared signals</b> and <b>Auto-trade</b>. Each run shows what it did and an expandable log. If signals look stale, check the newest refresh run.</p>
      <div class="card"><div id="cron-table"><div class="empty">Loading…</div></div></div>
    </div>
  `;

  const { runs, err } = await loadRuns();
  const el = document.getElementById('cron-table');

  if (err) {
    el.innerHTML = `<div class="empty" style="text-align:left"><b>Couldn't load run history.</b><br><span style="color:var(--red);font-family:var(--font-mono);font-size:0.9rem">${escapeHtml(err)}</span><div style="margin-top:8px;color:var(--text-mute);font-size:0.85rem">If this is a permissions error, deploy the latest Firestore rules (the <code>cronRuns</code> read rule).</div></div>`;
    return;
  }
  if (!runs.length) {
    el.innerHTML = `<div class="empty"><b>No runs recorded yet.</b><br><br>Run history is captured from the next worker run onward. Trigger one: GitHub → Actions → Refresh shared signals (or Auto-trade) → Run workflow.</div>`;
    return;
  }

  const jobLabel = (j) => j === 'auto-trade' ? 'AUTO-TRADE' : 'REFRESH';
  const resultBadge = (r) => r.ok ? '<span class="badge win">OK</span>' : (r.error ? '<span class="badge loss">FAILED</span>' : '<span class="badge">PARTIAL</span>');

  function detailFor(r) {
    if (r.job === 'auto-trade') {
      return `${r.dryRun ? '<span class="badge">DRY-RUN</span> ' : '<span class="badge loss">LIVE/REAL</span> '}`
        + `users ${r.users ?? '–'} · placed ${r.placed ?? 0} · skipped ${r.skipped ?? 0} · errors ${r.errors ?? 0}`
        + (r.note ? ` · <i>${escapeHtml(r.note)}</i>` : '');
    }
    const ws = r.watchlistSet ? `<span class="badge">${escapeHtml(r.watchlistSet)}</span> ` : '';
    const mk = (r.markets || []).map(m => {
      const c = m.error ? 'var(--red)' : 'var(--text)';
      const d = m.error ? `error: ${m.error}` : `${m.written ?? '–'} written · ${m.buys ?? '–'}/${m.sells ?? '–'} b/s · settled ${m.settled ?? '–'} · err ${m.errors ?? 0}`;
      return `<span style="color:${c}"><b>${escapeHtml(m.market)}</b> ${escapeHtml(d)}</span>`;
    }).join(' &nbsp;|&nbsp; ');
    return ws + (mk || '—');
  }

  // "Last run" summary per job.
  const lastByJob = {};
  for (const r of runs) { const j = r.job || 'refresh'; if (!lastByJob[j]) lastByJob[j] = r; }
  const summaryLine = Object.values(lastByJob).map(r => {
    const j = r.job || 'refresh';
    const fresh = r.createdAt?.toDate ? (Date.now() - r.createdAt.toDate().getTime()) < 16 * 3600 * 1000 : true;
    const staleNote = (j === 'refresh' && !fresh) ? ' <b style="color:var(--amber)">STALE</b>' : '';
    return `<div><b>${jobLabel(j)}</b> ${resultBadge(r)} · ${escapeHtml(fmtTs(r.finishedAt || r.createdAt))} (${escapeHtml(ago(r.createdAt))})${staleNote}</div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;font-family:var(--font-mono);font-size:0.9rem;color:var(--text-mute)">${summaryLine}</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${runs.map(r => {
        const dur = r.durationMs != null ? (r.durationMs / 1000).toFixed(0) + 's' : '—';
        const logs = Array.isArray(r.logs) ? r.logs : [];
        return `<div class="card" style="padding:12px 14px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:0.9rem">
            <span class="badge ${r.job === 'auto-trade' ? 'tier-t1' : 'tier-t2'}">${jobLabel(r.job || 'refresh')}</span>
            ${resultBadge(r)}
            <span style="color:var(--text-dim);font-family:var(--font-mono)">${escapeHtml(fmtTs(r.finishedAt || r.createdAt))}</span>
            <span style="color:var(--text-mute);font-family:var(--font-mono)">${escapeHtml(ago(r.createdAt))}</span>
            <span style="color:var(--text-mute);font-family:var(--font-mono)">${dur}</span>
            <span style="color:var(--text-mute)">${escapeHtml(r.trigger || '')}</span>
          </div>
          <div style="margin-top:8px;font-family:var(--font-mono);font-size:0.85rem">${detailFor(r)}</div>
          ${r.error ? `<div style="margin-top:6px;color:var(--red);font-family:var(--font-mono);font-size:0.82rem">${escapeHtml(String(r.error).slice(0, 300))}</div>` : ''}
          ${logs.length ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--cyan);font-size:0.85rem">log (${logs.length} lines)</summary>
            <pre style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px 10px;margin:6px 0 0;font-family:var(--font-mono);font-size:0.78rem;color:var(--text);overflow-x:auto;max-height:340px;white-space:pre-wrap">${escapeHtml(logs.join('\n'))}</pre>
          </details>` : ''}
        </div>`;
      }).join('')}
    </div>
  `;
}
