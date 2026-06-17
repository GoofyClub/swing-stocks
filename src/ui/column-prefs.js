// =============================================================================
// Reusable per-table column preferences: order + visibility, persisted to
// localStorage and reconciled against the table's current column set so adding
// or removing a column in code never corrupts a user's saved layout.
//
// Shared by Signal History and Live Signals (and available to any future table).
// =============================================================================

import { openModal } from './modal.js';

const LS_PREFIX = 'swing.cols.';

// Returns { order: string[], hidden: Set<string> } for a table.
// `defaultOrder` is the authoritative list of known column keys, in the order
// they should appear by default. Saved prefs are filtered to known keys and any
// newly-added column is appended (visible) so upgrades degrade gracefully.
export function loadColumnPrefs(tableKey, defaultOrder) {
  const known = new Set(defaultOrder);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_PREFIX + tableKey) || 'null'); } catch {}
  if (!saved || !Array.isArray(saved.order)) {
    return { order: [...defaultOrder], hidden: new Set() };
  }
  const order = saved.order.filter(k => known.has(k));
  for (const k of defaultOrder) if (!order.includes(k)) order.push(k); // append new columns
  const hidden = new Set((Array.isArray(saved.hidden) ? saved.hidden : []).filter(k => known.has(k)));
  return { order, hidden };
}

export function saveColumnPrefs(tableKey, prefs) {
  try {
    localStorage.setItem(LS_PREFIX + tableKey, JSON.stringify({ order: prefs.order, hidden: [...prefs.hidden] }));
  } catch {}
}

export function resetColumnPrefs(tableKey) {
  try { localStorage.removeItem(LS_PREFIX + tableKey); } catch {}
}

// The list of column keys to actually render, in order, excluding hidden ones
// and any keys the caller marks as non-hideable/fixed (e.g. an action column).
export function visibleColumns(prefs, fixedKeys = []) {
  const fixed = new Set(fixedKeys);
  return prefs.order.filter(k => fixed.has(k) || !prefs.hidden.has(k));
}

// Opens a dialog to reorder (▲/▼) and toggle column visibility. `columns` is a
// map of key -> { label }. `fixedKeys` can't be hidden (but can be reordered).
// `defaultOrder` is used by the in-dialog "Reset to default" button. Calls
// onApply(newPrefs) when the user saves.
export function openColumnConfig({ tableKey, columns, prefs, defaultOrder = [], fixedKeys = [], onApply }) {
  // Work on a local copy so Cancel discards.
  let order = [...prefs.order];
  let hidden = new Set(prefs.hidden);
  const fixed = new Set(fixedKeys);

  const rowHtml = (key, i) => {
    const label = columns[key]?.label || key;
    const isHidden = hidden.has(key);
    const canHide = !fixed.has(key);
    return `
      <div class="col-cfg-row" data-key="${key}" style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--line-soft)">
        <span style="display:flex;gap:2px">
          <button type="button" class="btn-bare col-up"   data-i="${i}" title="Move up"   style="padding:2px 7px"${i === 0 ? ' disabled' : ''}>▲</button>
          <button type="button" class="btn-bare col-down" data-i="${i}" title="Move down" style="padding:2px 7px"${i === order.length - 1 ? ' disabled' : ''}>▼</button>
        </span>
        <label style="display:flex;align-items:center;gap:8px;flex:1;text-transform:none;letter-spacing:normal;color:var(--text);cursor:${canHide ? 'pointer' : 'default'}">
          <input type="checkbox" class="col-vis" ${isHidden ? '' : 'checked'} ${canHide ? '' : 'disabled'}>
          <span>${label}${canHide ? '' : ' <span style="color:var(--text-mute);font-size:0.8rem">(fixed)</span>'}</span>
        </label>
      </div>`;
  };

  const render = () => `
    <div style="font-size:0.85rem;color:var(--text-mute);margin-bottom:8px">Reorder with ▲▼, uncheck to hide. Saved to this browser.</div>
    <div id="col-cfg-list">${order.map(rowHtml).join('')}</div>
    <button type="button" id="col-cfg-reset" class="btn-bare" style="margin-top:12px">Reset to default</button>
  `;

  openModal({
    title: 'Customize columns',
    bodyHtml: render(),
    primaryLabel: 'Apply',
    onPrimary: () => { onApply({ order: [...order], hidden: new Set(hidden) }); },
  });

  // Wire interactions after the modal mounts. We re-read the live list element.
  const host = document.getElementById('modal-host');
  const list = host?.querySelector('#col-cfg-list');
  if (!list) return;

  const repaint = () => {
    list.innerHTML = order.map(rowHtml).join('');
    wire();
  };
  function wire() {
    list.querySelectorAll('.col-up').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; repaint(); }
    }));
    list.querySelectorAll('.col-down').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; repaint(); }
    }));
    list.querySelectorAll('.col-cfg-row').forEach(rowEl => {
      const key = rowEl.dataset.key;
      const cb = rowEl.querySelector('.col-vis');
      cb?.addEventListener('change', () => { if (cb.checked) hidden.delete(key); else hidden.add(key); });
    });
  }
  wire();
  host.querySelector('#col-cfg-reset')?.addEventListener('click', () => {
    if (defaultOrder.length) { order = [...defaultOrder]; hidden = new Set(); repaint(); }
  });
}
