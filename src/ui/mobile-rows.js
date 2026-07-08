// =============================================================================
// Compact mobile list rows ("Design A") for signal-style tables.
//
// On phones (≤640px) the wide signal tables are hidden and each row renders as
// a compact 3-line entry instead:
//   ① ticker · name · badges
//   ② strategy · sector · index · date        (muted meta line)
//   ③ E entry  TP tp  SL sl            %Δ     (prices + right-aligned figure)
// Tapping a row expands the remaining fields (native <details>, no JS state).
//
// Views render this HTML right after their <table class="data"> inside a
// `.tbl-mobile-switch` wrapper; app.css swaps table ↔ rows at the breakpoint.
// All values passed in must already be HTML-escaped by the caller.
// =============================================================================

// rows: [{ starHtml?, ticker, name?, badgesHtml?, meta?, nums?: [{k,v,color?}],
//          right?: {v,color?}, detail?: [{k,v,wide?}], actionsHtml? }]
export function mobileRowsHTML(rows) {
  return `<div class="mrows">${rows.map(r => {
    const nums = (r.nums || []).map(n =>
      `<span${n.color ? ` style="color:${n.color}"` : ''}><span class="mr-k">${n.k}</span>${n.v}</span>`).join('');
    const right = r.right ? `<span class="mr-right"${r.right.color ? ` style="color:${r.right.color}"` : ''}>${r.right.v}</span>` : '';
    const detail = (r.detail || []).map(d =>
      `<span class="mr-f${d.wide ? ' mr-wide' : ''}"><span class="mr-k">${d.k}</span><span class="mr-v">${d.v}</span></span>`).join('');
    return `
    <details class="mrow">
      <summary>
        ${r.starHtml ? `<span class="mr-star">${r.starHtml}</span>` : ''}
        <span class="mr-main">
          <span class="mr-l1"><b class="mr-tick">${r.ticker}</b><span class="mr-name">${r.name || ''}</span><span class="mr-badges">${r.badgesHtml || ''}</span></span>
          ${r.meta ? `<span class="mr-l2">${r.meta}</span>` : ''}
          ${(nums || right) ? `<span class="mr-l3">${nums}${right}</span>` : ''}
        </span>
        <span class="mr-chev" aria-hidden="true">▾</span>
      </summary>
      <div class="mr-detail">
        ${detail}
        ${r.actionsHtml ? `<div class="mr-actions">${r.actionsHtml}</div>` : ''}
      </div>
    </details>`;
  }).join('')}</div>`;
}

// Buttons inside a row's <summary> (e.g. the ★ track button) do their own
// thing — preventDefault stops the tap from ALSO toggling the row open.
// Call after the container's innerHTML is set, before/after other wiring.
export function guardMobileRowButtons(container) {
  container.querySelectorAll('.mrow summary button').forEach(b => {
    b.addEventListener('click', (e) => e.preventDefault());
  });
}
