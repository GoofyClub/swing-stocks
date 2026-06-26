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
      <h1>Cron Status</h1>
      <p class="subtitle">Execution history of the scheduled <b>Refresh shared signals</b> worker — when it last ran, how long it took, and what each market produced. If signals look stale, check the newest run here.</p>
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
    el.innerHTML = `<div class="empty"><b>No runs recorded yet.</b><br><br>Run history is captured from the next <b>Refresh shared signals</b> run onward (older runs predate this feature). Trigger one: GitHub → Actions → Refresh shared signals → Run workflow.</div>`;
    return;
  }

  const newest = runs[0];
  const fresh = newest.createdAt?.toDate ? (Date.now() - newest.createdAt.toDate().getTime()) < 16 * 3600 * 1000 : true;

  el.innerHTML = `
    <div style="margin-bottom:12px;font-family:var(--font-mono);font-size:0.9rem;color:${fresh ? 'var(--text-mute)' : 'var(--amber)'}">
      Last run: <b style="color:var(--text)">${escapeHtml(fmtTs(newest.finishedAt || newest.createdAt))}</b> (${escapeHtml(ago(newest.createdAt))})${fresh ? '' : ' — <b style="color:var(--amber)">STALE: no recent run; signals may be out of date.</b>'}
    </div>
    <table class="data">
      <thead><tr>
        <th>FINISHED</th><th>TRIGGER</th><th>RESULT</th><th class="num">DURATION</th><th>PER-MARKET (written · buys/sells · settled · errors)</th>
      </tr></thead>
      <tbody>
        ${runs.map(r => {
          const okBadge = r.ok ? '<span class="badge win">OK</span>' : (r.error ? '<span class="badge loss">FAILED</span>' : '<span class="badge">PARTIAL</span>');
          const dur = r.durationMs != null ? (r.durationMs / 1000).toFixed(0) + 's' : '—';
          const mk = (r.markets || []).map(m => {
            const c = m.error ? 'var(--red)' : 'var(--text)';
            const detail = m.error ? `error: ${m.error}` : `${m.written ?? '–'} · ${m.buys ?? '–'}/${m.sells ?? '–'} · ${m.settled ?? '–'} · ${m.errors ?? 0}`;
            return `<span style="color:${c}"><b>${escapeHtml(m.market)}</b> ${escapeHtml(detail)}</span>`;
          }).join(' &nbsp;|&nbsp; ');
          return `<tr title="${escapeHtml(r.error || '')}">
            <td>${escapeHtml(fmtTs(r.finishedAt || r.createdAt))}</td>
            <td>${escapeHtml(r.trigger || '—')}</td>
            <td>${okBadge}</td>
            <td class="num">${dur}</td>
            <td style="font-family:var(--font-mono);font-size:0.85rem">${mk || '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}
