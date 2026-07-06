// =============================================================================
// Lightweight multi-select dropdown (checkbox list in a <details>). Used for the
// strategy filter on Signal History + Live Signals so several strategies can be
// selected at once. No dependency; state lives in the checkboxes.
//
// Empty selection means "all" (no filtering), matching the previous single-select
// "All strategies" behaviour.
// =============================================================================

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// HTML for an (initially empty) multi-select. Fill options later with fillMultiSelect.
export function multiSelectHtml(id, allLabel = 'All') {
  return `<details class="ms" id="${id}" data-all-label="${escapeHtml(allLabel)}">
    <summary class="btn-bare ms-summary">${escapeHtml(allLabel)}</summary>
    <div class="ms-menu"></div>
  </details>`;
}

export function getMultiSelectValues(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return [...el.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
}

function updateSummary(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const vals = getMultiSelectValues(id);
  const sum = el.querySelector('.ms-summary');
  const allLabel = el.dataset.allLabel || 'All';
  sum.textContent = vals.length === 0 ? allLabel
    : vals.length === 1 ? vals[0]
    : `${vals.length} selected`;
}

// (Re)populate the option list, PRESERVING any current selection that still
// exists (so callers that refresh options from live data don't lose the filter).
export function fillMultiSelect(id, options) {
  const el = document.getElementById(id);
  if (!el) return;
  const keep = new Set(getMultiSelectValues(id));
  const menu = el.querySelector('.ms-menu');
  menu.innerHTML = options.map(o => {
    const value = typeof o === 'string' ? o : o.value;
    const label = typeof o === 'string' ? o : (o.label ?? o.value);
    return `<label class="ms-item"><input type="checkbox" value="${escapeHtml(value)}" ${keep.has(value) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
  }).join('');
  updateSummary(id);
}

export function setMultiSelectValues(id, values) {
  const el = document.getElementById(id);
  if (!el) return;
  const set = new Set(values || []);
  el.querySelectorAll('input[type=checkbox]').forEach(i => { i.checked = set.has(i.value); });
  updateSummary(id);
}

export function clearMultiSelect(id) { setMultiSelectValues(id, []); }

export function wireMultiSelect(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  const menu = el.querySelector('.ms-menu');
  
  // Handle checkbox changes
  menu.addEventListener('change', () => { 
    updateSummary(id); 
    onChange(getMultiSelectValues(id)); 
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!el.contains(e.target) && el.open) {
      el.open = false;
    }
  });
}
