// =============================================================================
// Collapsible filter bar with persisted state.
//
// Views wrap their filter controls in a body element and add a small toggle
// button; this wires the two together and remembers the choice per view in
// localStorage. Default: hidden on phones (filters eat half the screen),
// visible on desktop — until the user toggles, which then always wins.
// =============================================================================

const LS_PREFIX = 'swing.filtersHidden.';

export function initFilterCollapse({ viewKey, bodyEl, btnEl }) {
  if (!bodyEl || !btnEl) return;
  let hidden = null;
  try { hidden = localStorage.getItem(LS_PREFIX + viewKey); } catch {}
  if (hidden !== '0' && hidden !== '1') {
    hidden = window.matchMedia('(max-width: 640px)').matches ? '1' : '0';
  }
  const apply = () => {
    bodyEl.style.display = hidden === '1' ? 'none' : '';
    btnEl.textContent = hidden === '1' ? '▸ FILTERS' : '▾ FILTERS';
    btnEl.title = hidden === '1' ? 'Show filters' : 'Hide filters';
    btnEl.setAttribute('aria-expanded', hidden === '1' ? 'false' : 'true');
  };
  btnEl.addEventListener('click', () => {
    hidden = hidden === '1' ? '0' : '1';
    try { localStorage.setItem(LS_PREFIX + viewKey, hidden); } catch {}
    apply();
  });
  apply();
}
