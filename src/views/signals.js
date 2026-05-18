// Live Signals — a thin wrapper that links to the legacy console for now (full
// interactive scanner). The next iteration will inline the scan UI in the new shell.

export function renderSignals(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Live Signals</h1>
      <p class="subtitle">Interactive scanner — runs all strategies on the current watchlist.</p>
      <div class="card">
        <p style="color:var(--text-dim);margin:0 0 12px">
          The full interactive scan UI from the legacy console is being ported into this shell.
          In the meantime, the original console — with every chart, filter, and self-test — is
          preserved verbatim and reachable below.
        </p>
        <a class="btn-bare" href="legacy/swing_terminal_4-1.html" target="_blank" rel="noopener">
          OPEN LEGACY CONSOLE ↗
        </a>
      </div>
    </div>
  `;
}
