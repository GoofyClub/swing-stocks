// Automation Guide — everything about auto-trading signals: how it works, the
// settings reference, risk management, broker setup, safety, and the roadmap.
//
// MAINTENANCE: keep this in lockstep with automation features. When you add or
// change an automation capability, update (1) the relevant section here and
// (2) the "Enhancement log" at the bottom. The Settings reference must list
// every field present in DEFAULT_AUTOMATION (src/data/automation.js).

export function renderAutomationGuide(root) {
  root.innerHTML = `
    <div class="view guide-view">
      <h1>Automation Guide</h1>
      <p class="subtitle">How auto-trading works, what every setting does, how risk is managed, and what's live vs. coming. Configure it on the <a href="#/automation" style="color:var(--cyan)">Automation</a> page.</p>

      <nav class="guide-toc card">
        <div class="toc-title">QUICK NAVIGATION</div>
        <div class="toc-grid">
          <a href="#a-status">★ Status &amp; roadmap</a>
          <a href="#a-how">1. How it works</a>
          <a href="#a-settings">2. Settings reference</a>
          <a href="#a-risk">3. Risk management</a>
          <a href="#a-pro">4. What pro automation does</a>
          <a href="#a-broker">5. Broker setup</a>
          <a href="#a-enable">5b. Turning it on</a>
          <a href="#a-safety">6. Safety &amp; paper-first</a>
          <a href="#a-legal">7. Legal &amp; compliance</a>
          <a href="#a-glossary">8. Glossary</a>
          <a href="#a-log">9. Enhancement log</a>
        </div>
      </nav>

      <section class="guide-section" id="a-status">
        <h2>★ Status &amp; roadmap</h2>
        <div class="guide-warn"><b>Current status: paper worker shipped, scheduled + dry-run by default.</b> The execution worker (<code>scripts/auto-trade.mjs</code>) runs on a schedule across the morning (entries gated to the 09:30–11:00 ET window) plus an afternoon reconcile, via the <i>Auto-trade (paper)</i> GitHub Action. It defaults to <b>DRY_RUN</b> (logs intended orders without submitting) and to the Alpaca <b>paper</b> endpoint. It only acts for users who set <b>Enable = on</b> and provided broker keys.</div>
        <p>Rollout is phased so real money is only ever at risk after the safeguards are proven:</p>
        <ol>
          <li><b>Phase 1 — Config (shipped):</b> rules UI (markets, strategies, tiers, risk, filters), persisted per user.</li>
          <li><b>Phase 2 — Paper execution (shipped):</b> worker reads the previous session's matching signals + your rules, sizes by fixed-fractional risk, and submits <b>bracket orders</b> with a slippage-bounded <b>limit entry</b> to a paper account. Idempotent (deterministic client order id), with an order journal + reconciliation. Scheduled across the morning window, dry-run by default.</li>
          <li><b>Phase 3 — Guardrails (shipped):</b> position/sector caps, portfolio-heat cap, daily-loss halt, slippage guard, trade-day gate, <b>market-regime gate</b> (blocks new longs when risk-off), and a <b>global kill switch</b> (env <code>KILL_SWITCH</code> or <code>publicConfig/automation.paused</code>). An <b>Auto Orders</b> page shows what the worker did.</li>
          <li><b>Phase 4 — Live (small size):</b> US first, tiny position sizes; India once the regulatory path is confirmed. Pre-trade live-quote slippage check and a market-hours guard are <b>in</b>; an Alpaca smoke-test (<code>npm run auto:smoketest</code>) validates the adapter against a real paper account.</li>
        </ol>
        <p class="muted">How to run it: GitHub → Actions → <b>Auto-trade (paper)</b> → Run workflow. Leave <code>dry_run = true</code> first and read the logs; set it to <code>false</code> only once the dry-run output looks right.</p>
      </section>

      <section class="guide-section" id="a-how">
        <h2>1. How it works</h2>
        <p>Automation reuses the same signals you see in Live Signals and Signal History. The pipeline:</p>
        <ol>
          <li><b>Signal generated</b> — the EOD cron writes each trading session's signals (entry, TP, SL, tier, strategy, index) to that day's bucket.</li>
          <li><b>Next-morning pickup</b> — the worker reads the <b>previous trading session's</b> bucket (calendar-aware, so it skips weekends and holidays) and acts on it only during the <b>entry window (09:30–13:00 ET)</b>. A session's signals are eligible on exactly one morning, then expire — nothing stale is ever entered days later.</li>
          <li><b>Rule match</b> — the worker keeps only signals that pass your filters (market, tier, strategy, <b>index</b> incl. Large Cap, side, price band, liquidity, exclusion list).</li>
          <li><b>Position sizing</b> — shares are sized so the distance to your stop equals your <i>risk per trade %</i> of equity.</li>
          <li><b>Order placement</b> — a <b>bracket order</b> (entry + stop-loss + take-profit) is submitted so every fill is protected. The entry is a <b>limit order bounded by your slippage budget</b> (not a market order), so a late-firing run fills near the signal price or not at all — never chasing a moved price. Buy-stop strategies keep their stop-entry trigger.</li>
          <li><b>Reconciliation</b> — the worker polls fills/positions and syncs outcomes back (the same way Signal History settles), and cancels any prior-session entry limit still unfilled so it can't fill late.</li>
          <li><b>Exit management</b> — filled positions are managed with the <b>same exit model that settles Signal History</b>: RSI2's indicator exit (close back above the 5-SMA), each strategy's <b>time stop</b> (e.g. RSI2 7 sessions, VCP 25), and the <b>trailing-stop</b> model for trend strategies (breakeven at +1R, trail 2R below the high). When the model exits, the worker liquidates the position and cancels the bracket legs; the fixed TP/SL legs keep resting at the broker the whole time as protection. Evaluated on every run — the ~15:45 ET pass gives it end-of-day granularity matching the EOD rules.</li>
        </ol>
        <p class="muted">Because secrets can't live safely in a browser, order placement runs on a trusted server worker (scheduled across the morning; entries are gated to the open window), not in this web app.</p>
      </section>

      <section class="guide-section" id="a-settings">
        <h2>2. Settings reference</h2>
        <table class="data"><thead><tr><th>Setting</th><th>What it does</th></tr></thead><tbody>
          <tr><td><b>Enable automation</b></td><td>Master switch. Off = nothing is traded, even with everything else configured.</td></tr>
          <tr><td><b>Mode</b></td><td><b>Paper</b> = simulated orders against a paper account. <b>Live</b> = real money. Always start in paper.</td></tr>
          <tr><td><b>Broker / REST API base</b></td><td>Which broker and endpoint the worker talks to (e.g. Alpaca paper vs. live URL).</td></tr>
          <tr><td><b>API key / secret</b></td><td>Credentials the worker authenticates with. Use a paper key until live; never one with withdrawal rights.</td></tr>
          <tr><td><b>Markets</b></td><td>Which markets to auto-trade (US, India). Match the broker you connected.</td></tr>
          <tr><td><b>Tiers</b></td><td>Trade only these conviction tiers (A+, Tier 1, Tier 2). A+-only is the safest start.</td></tr>
          <tr><td><b>Sides</b></td><td>Buy and/or sell signals.</td></tr>
          <tr><td><b>Strategies</b></td><td>Allow-list of strategies. None checked = all strategies eligible.</td></tr>
          <tr><td><b>Indices</b></td><td>Allow-list of index membership — <b>Large Cap</b> (curated large-cap watchlist), S&amp;P 500, MidCap 400, SmallCap 600. None checked = all. Large Cap overlaps S&amp;P 500, so a name can match either. An advanced per-strategy override can pin one strategy to specific indices (e.g. RSI2 → Large Cap only).</td></tr>
          <tr><td><b>Trade days</b></td><td>Weekdays the worker is allowed to open new positions.</td></tr>
          <tr><td><b>Min / Max price</b></td><td>Skip signals priced outside this band (avoid illiquid penny names / very high-priced shares).</td></tr>
          <tr><td><b>Min 20d $ ADV</b></td><td>Liquidity floor — skip names that don't trade enough dollar volume to fill cleanly.</td></tr>
          <tr><td><b>Exclude tickers</b></td><td>Symbols to never auto-trade, regardless of signal (e.g. names you hold elsewhere or distrust).</td></tr>
          <tr><td><b>Sizing mode</b></td><td><b>Risk %</b> = size so a fixed % of equity is at risk (capital used varies with stop width). <b>Fixed $</b> = spend a set dollar amount per trade — best for small accounts.</td></tr>
          <tr><td><b>Fixed $ per trade</b></td><td>[Fixed mode] Dollars to deploy per signal. Whole shares only, so a budget below one share's price skips that trade. Pair with a low <i>Max price</i> so signals are affordable.</td></tr>
          <tr><td><b>Max $ per position</b></td><td>Hard cap on dollars in any single position (both modes). 0 = no cap. The simplest way to guarantee you never put more than you intend into one name.</td></tr>
          <tr><td><b>Risk per trade %</b></td><td>[Risk mode] % of equity risked per trade. Shares = (equity × risk%) ÷ SL distance. Normalizes every trade to the same dollar risk.</td></tr>
          <tr><td><b>Max open positions</b></td><td>Hard cap on concurrent positions.</td></tr>
          <tr><td><b>Max per sector</b></td><td>Cap on positions in one sector — prevents over-concentration in a single theme.</td></tr>
          <tr><td><b>Max portfolio heat %</b></td><td>Cap on the <i>sum</i> of open risk across all positions — your worst-case same-day drawdown.</td></tr>
          <tr><td><b>Daily loss halt %</b></td><td>Stop opening new positions once the day's loss hits this level (intraday circuit breaker).</td></tr>
          <tr><td><b>Max drawdown halt %</b></td><td>Account-level circuit breaker: stop opening new positions when equity is this far below its all-time peak (high-water mark). A multi-day backstop; 0 = off. Existing positions keep their stops.</td></tr>
          <tr><td><b>Slippage budget %</b></td><td>Bounds the entry <b>limit price</b>: a buy fills at up to entry ×(1 + budget%), a sell down to entry ×(1 − budget%). It also skips a signal whose live price has already run past that bound before the order is placed.</td></tr>
        </tbody></table>
      </section>

      <section class="guide-section" id="a-risk">
        <h2>3. Risk management</h2>
        <p>The order-placing part is the easy 20%. Staying solvent is the other 80%:</p>
        <ul>
          <li><b>Fixed-fractional sizing</b> — always risk a constant % of equity, never a fixed share count. Each signal's SL distance sets the share count.</li>
          <li><b>Portfolio heat</b> — limit summed open risk, not just position count. 8 positions risking 1% each = 8% drawdown if they all stop out together.</li>
          <li><b>Sector caps</b> — avoid five correlated names in one theme masquerading as diversification.</li>
          <li><b>Daily-loss circuit breaker</b> — halt new entries after a bad day; live to trade tomorrow.</li>
          <li><b>Regime gate</b> — the engine already computes a market regime ("go to cash" when the index breaks its 200-day average / volatility spikes). Automation will hard-stop new longs in a risk-off regime.</li>
        </ul>
      </section>

      <section class="guide-section" id="a-pro">
        <h2>4. What pro automation traders do</h2>
        <ul>
          <li><b>Paper/shadow first</b> — run the full pipeline against a paper account for weeks; the gap between paper fills and the backtest is your real-world edge decay.</li>
          <li><b>Bracket / OCO orders</b> — submit entry + stop + target atomically so a fill is always protected, even if the worker dies.</li>
          <li><b>Slippage &amp; gap guards</b> — re-check live price at execution; skip if it gapped past entry. Use marketable limit orders, not naked market orders. <i>(Implemented: entries are slippage-bounded limit orders gated to the morning window.)</i></li>
          <li><b>Idempotency</b> — deterministic client order IDs so a re-run never double-submits.</li>
          <li><b>Reconciliation</b> — broker fills are the source of truth; sync positions, handle partial fills and rejects.</li>
          <li><b>Kill switch &amp; monitoring</b> — a global pause plus alerts on every fill, reject, and circuit-breaker trip.</li>
          <li><b>Audit journal</b> — log every decision (signal → matched rules → size → order → fill) for debugging and taxes.</li>
        </ul>
      </section>

      <section class="guide-section" id="a-broker">
        <h2>5. Broker setup</h2>
        <p><b>US — Alpaca</b> is the natural fit: clean REST API, free paper trading, native bracket orders, fractional shares. Paper base URL <code>https://paper-api.alpaca.markets</code>, live <code>https://api.alpaca.markets</code>. Generate a key in the Alpaca dashboard; paste the key id and secret on the Automation page.</p>
        <p><b>India — Zerodha Kite / Dhan / Upstox.</b> ⚠️ SEBI regulates retail algo/API trading: brokers require approval/registration for automated order placement, and the rules tightened in 2025. Confirm your broker's algo terms before enabling live. This path is stricter than the US.</p>
      </section>

      <section class="guide-section" id="a-enable">
        <h2>5b. Turning it on — two switches</h2>
        <p>There are <b>two independent gates</b>. Both must be set for real orders to flow:</p>
        <h3 style="color:var(--text-mute);font-size:0.8rem;letter-spacing:0.1em;text-transform:uppercase;margin:14px 0 6px">A · Per-account (in this app, on the <a href="#/automation" style="color:var(--cyan)">Automation</a> page)</h3>
        <ol>
          <li><b>Broker connection</b> — pick Alpaca, paste your API key + secret (paper keys), keep the paper REST base. Hit <b>Test connection</b>.</li>
          <li>Set your rules (markets, tiers, strategies, sizing, filters).</li>
          <li><b>Master switch</b> — tick <b>Enable automation</b>, set <b>Mode = Paper</b>.</li>
          <li>Click <b>SAVE AUTOMATION CONFIG</b>. (Saving needs the Firestore rules deployed — see SETUP.)</li>
        </ol>
        <p class="muted">Mode = Paper forces the Alpaca paper endpoint no matter what. Switch to Live only after weeks of clean paper results.</p>
        <h3 style="color:var(--text-mute);font-size:0.8rem;letter-spacing:0.1em;text-transform:uppercase;margin:14px 0 6px">B · The run-mode switch (GitHub, controls the scheduled worker)</h3>
        <p>The worker runs on a daily schedule but is <b>dry-run by default</b> — it logs intended orders and submits nothing. To let the <b>scheduled</b> runs actually place (paper) orders:</p>
        <div class="guide-pass">
          <b>Repo → Settings → Secrets and variables → Actions → Variables → New variable:</b>
          <pre style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px 10px;margin:8px 0;font-family:var(--font-mono);font-size:0.85rem;color:var(--text)">AUTO_DRY_RUN = false</pre>
          Leave it unset (or <code>true</code>) and every scheduled run stays a dry-run. A manual <b>Actions → Auto-trade (paper) → Run workflow</b> can always override via the <code>dry_run</code> input.
        </div>
        <p><b>Summary (paper):</b> dry-run logs only; to trade paper for real you need <b>(A)</b> Enable + saved config with the <b>paper</b> URL <i>and</i> <b>(B)</b> <code>AUTO_DRY_RUN=false</code>. Watch every decision on <a href="#/auto-orders" style="color:var(--cyan)">Auto Orders</a>. Stop everything instantly with the kill switch (<code>kill_switch</code> input or <code>publicConfig/automation.paused=true</code>).</p>
        <h3 style="color:var(--text-mute);font-size:0.8rem;letter-spacing:0.1em;text-transform:uppercase;margin:14px 0 6px">C · Going to REAL MONEY (live)</h3>
        <p>The broker <b>URL</b> is the paper-vs-live switch. Going live takes <b>three deliberate flips</b>:</p>
        <ol>
          <li>Broker <b>URL</b> → <code>https://api.alpaca.markets</code> (in the app).</li>
          <li>Your <b>live</b> Alpaca API key + secret (paper keys won't authenticate live).</li>
          <li>Repo variable <code>ALLOW_LIVE = true</code>.</li>
        </ol>
        <p><b>Hard safety gate:</b> if a broker URL is live but <code>ALLOW_LIVE</code> isn't set, the worker <b>skips that account entirely</b> — the in-app setting alone can never place a real-money order. (And <code>AUTO_DRY_RUN=false</code> must still be set, as for paper.)</p>
      </section>

      <section class="guide-section" id="a-safety">
        <h2>6. Safety &amp; paper-first</h2>
        <div class="guide-pass">
          <b>Recommended path:</b>
          <ol>
            <li>Configure rules with <b>Enable = off</b>. Review them against recent Signal History.</li>
            <li>Turn on <b>paper</b> mode once the worker ships. Let it run for 30+ trades.</li>
            <li>Compare paper results to the backtest. Investigate any large divergence.</li>
            <li>Go <b>live, US-only, tiny size</b> (A+-only, 0.25–0.5% risk). Scale only after 100+ live trades behave.</li>
          </ol>
        </div>
        <p>Keep the API key scoped to trading only (no withdrawals). The master switch and per-account mode default OFF/paper for a reason — leave them there until you've earned the confidence to change them.</p>
      </section>

      <section class="guide-section" id="a-legal">
        <h2>7. Legal &amp; compliance</h2>
        <ul>
          <li><b>US Pattern Day Trader rule — removed.</b> The old $25k minimum / 3-day-trades-per-5-days restriction no longer applies, so day-trade frequency isn't capped by account size. (Confirm your broker's current terms, which can differ.)</li>
          <li><b>India SEBI</b> — automated/API order placement requires broker approval; verify before going live.</li>
          <li><b>Taxes</b> — keep the audit journal; track wash sales (US) and short-term gains.</li>
          <li><b>This is not financial advice.</b> You are responsible for every order placed under your credentials.</li>
        </ul>
      </section>

      <section class="guide-section" id="a-glossary">
        <h2>8. Glossary</h2>
        <table class="data"><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody>
          <tr><td><b>Bracket / OCO order</b></td><td>An entry order bundled with a stop-loss and take-profit; filling one cancels the other.</td></tr>
          <tr><td><b>R / risk per trade</b></td><td>1R = the distance from entry to stop. Sizing so 1R = a fixed % of equity equalizes risk across trades.</td></tr>
          <tr><td><b>Portfolio heat</b></td><td>Sum of open risk (in R or %) across all positions — your aggregate exposure.</td></tr>
          <tr><td><b>Slippage</b></td><td>The difference between expected and actual fill price.</td></tr>
          <tr><td><b>Idempotency</b></td><td>Property that re-running an action (e.g. a cron pass) doesn't duplicate orders.</td></tr>
          <tr><td><b>Reconciliation</b></td><td>Syncing the broker's true positions/fills back into the app's records.</td></tr>
        </tbody></table>
      </section>

      <section class="guide-section" id="a-log">
        <h2>9. Enhancement log</h2>
        <p class="muted">Newest first. Update this whenever automation changes.</p>
        <table class="data"><thead><tr><th>Date</th><th>Change</th></tr></thead><tbody>
          <tr><td>2026-07-09</td><td><b>Exit management shipped:</b> the worker now closes real positions per the tracked exit model — RSI2's 5-SMA indicator exit, per-strategy time stops, and trailing stops for trend strategies — instead of only waiting on the bracket TP/SL. Rejected placements retry on later runs; bracket prices round to broker increments (sub-penny fix); entry window widened to 09:30–13:00 ET to absorb GitHub cron lag.</td></tr>
          <tr><td>2026-07-05</td><td><b>Morning-window execution + one-session freshness.</b> The worker now enters from the <b>previous trading session's</b> bucket (calendar-aware; skips weekends/holidays) only inside the <b>09:30–11:00 ET</b> window, so it no longer waits on the morning refresh and can't trade stale signals days later. Entries are now <b>slippage-bounded limit orders</b> (not market) so a late run can't chase price; unfilled prior-session entries are cancelled. Extra morning cron triggers absorb GitHub Actions lag. Added a <b>Large Cap</b> curated index filter and made the <b>Index &amp; Tier filters multi-select</b> on Live Signals, History, and Automation.</td></tr>
          <tr><td>2026-06-26</td><td>Auto-trade worker now runs on a <b>daily schedule</b> (after the open + near the close), dry-run until the repo variable <code>AUTO_DRY_RUN=false</code> is set. Added an <b>Options Playbook</b> page (per-strategy options guidance, rules only). Trend strategies now settle on a <b>trailing stop</b> (RSI2 unchanged — keeps its 5-SMA native exit).</td></tr>
          <tr><td>2026-06-18</td><td>Broker <b>Test connection</b> button (Alpaca), <b>Telegram</b> entry/exit alerts (Settings page + Test message), and a <b>Cron Status</b> page showing the refresh worker's execution history.</td></tr>
          <tr><td>2026-06-17</td><td>Risk + reporting: account-level <b>max-drawdown halt</b> (stops new entries when equity falls a set % below its peak; persists a high-water mark) and an <b>equity curve + P&amp;L summary</b> on the Auto Orders page (current/change/peak/drawdown from daily equity snapshots).</td></tr>
          <tr><td>2026-06-17</td><td>Phase 4 prep: pre-trade <b>live-quote slippage check</b> (Alpaca data API) and a <b>market-hours guard</b> (skips placing when the market is closed; dry-run continues). Added a read-only <b>Alpaca smoke-test</b> (<code>npm run auto:smoketest</code>). Noted that the US PDT $25k day-trading rule has been removed.</td></tr>
          <tr><td>2026-06-17</td><td>Sizing: added <b>Fixed $ per trade</b> mode and a <b>Max $ per position</b> cap (both whole-shares, bracket-safe) for small accounts, plus buying-power awareness in the worker (skips a trade it can't fund). Note: fractional shares aren't supported because Alpaca disallows them with bracket orders.</td></tr>
          <tr><td>2026-06-17</td><td>Phase 3: market-regime gate (blocks new longs when risk-off), global kill switch (env <code>KILL_SWITCH</code> / <code>publicConfig/automation.paused</code>), and an <b>Auto Orders</b> page showing the worker's journal. New "Respect market regime" toggle on the settings page.</td></tr>
          <tr><td>2026-06-17</td><td>Phase 2: paper-execution worker (<code>scripts/auto-trade.mjs</code> + <i>Auto-trade (paper)</i> Action). Risk-based sizing, bracket orders, idempotent client order ids, order journal + reconciliation, and guardrails (position/sector caps, portfolio heat, daily-loss halt, slippage, trade-day gate). Manual + dry-run by default; Alpaca paper enforced unless mode=live.</td></tr>
          <tr><td>2026-06-17</td><td>Phase 1: Automation settings page (broker connection, markets/tiers/strategies/sides, trade days, price band, liquidity floor, exclusion list, risk &amp; sizing) + this guide.</td></tr>
        </tbody></table>
      </section>
    </div>
  `;
}
