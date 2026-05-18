// =============================================================================
// Minimal hash-based router. Works under any GitHub Pages subpath because all
// routes are in the URL fragment (#/...), which never hits the server.
// =============================================================================

const handlers = new Map();
let _default = null;

export function route(name, render) {
  handlers.set(name, render);
}

export function defaultRoute(name) {
  _default = name;
}

export function currentRoute() {
  const h = window.location.hash || '';
  const cleaned = h.replace(/^#\/?/, '');
  const [name] = cleaned.split('?');
  return name || _default;
}

export function navigate(name) {
  if (currentRoute() === name) return;
  window.location.hash = '#/' + name;
}

export function start(rootEl) {
  function dispatch() {
    const r = currentRoute();
    const h = handlers.get(r) || handlers.get(_default);
    if (!h) {
      rootEl.innerHTML = `<div style="padding:24px">No route handler for <code>${r}</code></div>`;
      return;
    }
    try {
      h(rootEl);
    } catch (e) {
      console.error('[router] view render failed', e);
      rootEl.innerHTML = `<div style="padding:24px;color:#ff6b7a"><b>View failed to render.</b><br>${escapeHtml(e?.message || String(e))}</div>`;
    }
  }
  window.addEventListener('hashchange', dispatch);
  // Trigger initial dispatch on next tick so subscribers can attach first.
  setTimeout(dispatch, 0);
  return dispatch;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
