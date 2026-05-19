// Minimal accessible modal — single instance, mounted on first call.
// Use openModal({ title, bodyHtml, primaryLabel, onPrimary }) to show.

let host = null, cleanup = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.id = 'modal-host';
  host.innerHTML = `
    <style>
      #modal-host .backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        display: none;
        align-items: center; justify-content: center;
        z-index: 1000;
        animation: fade 0.12s ease-out;
      }
      #modal-host .backdrop.open { display: flex; }
      #modal-host .dialog {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 20px 22px;
        width: 100%;
        max-width: 420px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      }
      #modal-host h3 { margin: 0 0 12px; font-weight: 500; font-size: 1.23rem; }
      #modal-host .body { font-size: 1rem; color: var(--text-dim); margin-bottom: 18px; }
      #modal-host .row { display: grid; gap: 6px; margin-bottom: 12px; }
      #modal-host label { font-size: 0.85rem; color: var(--text-mute); text-transform: uppercase; letter-spacing: 0.08em; }
      #modal-host input, #modal-host textarea {
        background: var(--bg); color: var(--text);
        border: 1px solid var(--line-soft); border-radius: 4px;
        padding: 8px 10px;
        font-family: var(--font-mono); font-size: 0.92rem;
      }
      #modal-host textarea { font-family: var(--font-sans); resize: vertical; min-height: 60px; }
      #modal-host .err { color: var(--red); font-size: 0.92rem; margin-top: 4px; }
      #modal-host .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
      #modal-host .btn-primary {
        background: var(--cyan); border: 1px solid var(--cyan); color: var(--bg);
        font-weight: 500; padding: 8px 14px; border-radius: 4px;
      }
      #modal-host .btn-primary:disabled { opacity: 0.5; cursor: wait; }
      #modal-host .btn-secondary {
        background: transparent; border: 1px solid var(--line-soft); color: var(--text-dim);
        padding: 8px 14px; border-radius: 4px;
      }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    </style>
    <div class="backdrop" role="dialog" aria-modal="true">
      <div class="dialog">
        <h3 id="modal-title">Title</h3>
        <div class="body" id="modal-body"></div>
        <div class="actions">
          <button class="btn-secondary" id="modal-cancel" type="button">Cancel</button>
          <button class="btn-primary"   id="modal-ok"     type="button">OK</button>
        </div>
        <div class="err" id="modal-err" hidden></div>
      </div>
    </div>
  `;
  document.body.appendChild(host);
  return host;
}

export function openModal({ title, bodyHtml, primaryLabel = 'Confirm', onPrimary, onCancel }) {
  const h = ensureHost();
  const backdrop = h.querySelector('.backdrop');
  h.querySelector('#modal-title').textContent = title;
  h.querySelector('#modal-body').innerHTML = bodyHtml || '';
  h.querySelector('#modal-ok').textContent = primaryLabel;
  const err = h.querySelector('#modal-err');
  err.hidden = true;
  err.textContent = '';

  function close() {
    backdrop.classList.remove('open');
    if (cleanup) cleanup();
    cleanup = null;
  }

  async function confirm() {
    err.hidden = true;
    const okBtn = h.querySelector('#modal-ok');
    okBtn.disabled = true;
    const prevLabel = okBtn.textContent;
    okBtn.textContent = '…';
    try {
      const dialog = h.querySelector('.dialog');
      const result = onPrimary ? await onPrimary(dialog) : true;
      if (result !== false) close();
    } catch (e) {
      console.error('[modal] primary action failed', e);
      err.hidden = false;
      err.textContent = e?.message || String(e);
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = prevLabel;
    }
  }

  const okBtn = h.querySelector('#modal-ok');
  const cancelBtn = h.querySelector('#modal-cancel');
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); onCancel?.(); }
    if (e.key === 'Enter' && !e.target.matches('textarea')) { e.preventDefault(); confirm(); }
  };
  const onBackdrop = (e) => { if (e.target === backdrop) { close(); onCancel?.(); } };

  okBtn.addEventListener('click', confirm);
  cancelBtn.addEventListener('click', () => { close(); onCancel?.(); });
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', onBackdrop);

  cleanup = () => {
    okBtn.removeEventListener('click', confirm);
    cancelBtn.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
    backdrop.removeEventListener('click', onBackdrop);
  };

  backdrop.classList.add('open');
  // Focus the first input or the primary button.
  setTimeout(() => {
    const firstInput = h.querySelector('#modal-body input, #modal-body textarea');
    (firstInput || okBtn).focus();
  }, 0);
}
