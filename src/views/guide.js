// User Guide — port of the legacy "Newbie Guide" + "Framework reference" combined.
// Static content; renders once on view mount.

export function renderGuide(root) {
  root.innerHTML = `
    <div class="view guide-view">
      <h1>User Guide</h1>
      <p class="subtitle">How to use the tool, what each strategy does, and historical win rates. New to swing trading? Start at <b>Quick start</b>.</p>

      <nav class="guide-toc card">
        <div class="toc-title">QUICK NAVIGATION</div>
        <div class="toc-grid">
          <a href="#g-winrates">★ Win-rate reference</a>
          <a href="#g-start">1. Quick start</a>
          <a href="#g-workflow">2. Daily workflow</a>
          <a href="#g-tiers">3. Tier system (A+ / Tier 1 / Tier 2)</a>
          <a href="#g-tier1">4. Tier 1 strategies</a>
          <a href="#g-tier2">5. Tier 2 strategies</a>
          <a href="#g-sizing">6. Position sizing &amp; risk</a>
          <a href="#g-regime">7. Market regime</a>
          <a href="#g-design">◆ Strategy design notes (FAQ)</a>
          <a href="#g-mistakes">8. Common mistakes</a>
          <a href="#g-paper">9. Paper trade first</a>
          <a href="#g-glossary">10. Glossary</a>
        </div>
      </nav>

      <section class="guide-section" id="g-winrates">
        <h2>★ Strategy win-rate reference</h2>
        <p class="muted">Win rates are <b>historical, from peer-reviewed studies or published trader records</b>. Higher win rate ≠ bigger profit per trade. Sort by what fits your patience and risk tolerance.</p>
        <div style="overflow-x:auto">
        <table class="data strat-cmp">
          <thead><tr>
            <th>Tier</th><th>Strategy</th><th>Source</th><th class="num">Win rate</th>
            <th class="num">Avg gain</th><th class="num">Hold</th><th class="num">Frequency</th><th>Best for</th>
          </tr></thead>
          <tbody>
            <tr><td><span class="badge tier-aplus">A+</span></td><td><b>Composite A+</b></td><td>3+ edges stacked</td><td class="num"><b style="color:var(--green)">85%+</b></td><td class="num">varies</td><td class="num">3–15d</td><td class="num">0–3/wk</td><td>Highest conviction. Take every A+ when regime OK.</td></tr>
            <tr><td><span class="badge tier-t1">Tier 1</span></td><td><b>RSI(2) Mean Reversion</b></td><td>Connors &amp; Alvarez (2008)</td><td class="num"><b style="color:var(--green)">75–85%</b></td><td class="num">+1–3%</td><td class="num">2–7d</td><td class="num">1–5/wk</td><td>Risk-averse. Short hold, many small wins.</td></tr>
            <tr><td><span class="badge tier-t1">Tier 1</span></td><td><b>PEAD</b> <span class="api-tag">API</span></td><td>Ball &amp; Brown (1968)</td><td class="num"><b style="color:var(--green)">75–80%</b></td><td class="num">+5–20%</td><td class="num">10–60d</td><td class="num">seasonal</td><td>Earnings plays. Needs FMP key.</td></tr>
            <tr><td><span class="badge tier-t1">Tier 1</span></td><td><b>Gap-and-Go (PEG)</b></td><td>Minervini / Zanger</td><td class="num"><b style="color:var(--green)">65–72%</b></td><td class="num">+5–20%</td><td class="num">5–15d</td><td class="num">1–5/wk</td><td>News-driven catalysts.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>Insider Cluster</b> <span class="api-tag">API</span></td><td>Lakonishok &amp; Lee (2001)</td><td class="num"><b style="color:var(--amber)">65–75%</b></td><td class="num">+8–25%</td><td class="num">30–90d</td><td class="num">1–5/mo</td><td>Patient traders.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>High Tight Flag</b></td><td>O'Neil (CANSLIM)</td><td class="num"><b style="color:var(--amber)">65–75%</b></td><td class="num">+50–300%</td><td class="num">5–40d</td><td class="num">0–3/yr</td><td>Home-run hunters. Extremely rare.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>Analyst Upgrade</b> <span class="api-tag">API</span></td><td>Womack (1996)</td><td class="num"><b style="color:var(--amber)">60–70%</b></td><td class="num">+5–15%</td><td class="num">20–60d</td><td class="num">5–15/mo</td><td>Multi-firm upgrade plays.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>VCP Breakout</b></td><td>Minervini</td><td class="num"><b style="color:var(--amber)">55–68%</b></td><td class="num">+10–30%</td><td class="num">5–20d</td><td class="num">0–2/wk</td><td>Bigger winners.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>52-Week High Breakout</b></td><td>Jegadeesh &amp; Titman (1993)</td><td class="num"><b style="color:var(--amber)">60–65%</b></td><td class="num">+5–15%</td><td class="num">60–120d</td><td class="num">5–15/wk</td><td>Medium-term momentum.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>Pocket Pivot</b></td><td>Kacher &amp; Morales</td><td class="num"><b style="color:var(--amber)">55–65%</b></td><td class="num">+5–15%</td><td class="num">5–20d</td><td class="num">2–8/wk</td><td>Institutional accumulation.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>NR7 + Inside Day</b></td><td>Crabel (1990)</td><td class="num"><b style="color:var(--amber)">55–65%</b></td><td class="num">+3–8%</td><td class="num">1–5d</td><td class="num">3–10/wk</td><td>Volatility-expansion plays.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>Quality Dip</b></td><td>Mean-reversion on quality</td><td class="num"><b style="color:var(--amber)">60–70%</b></td><td class="num">+5–15%</td><td class="num">5–15d</td><td class="num">2–5/wk</td><td>"Buy the dip on blue chips" systematised.</td></tr>
            <tr><td><span class="badge tier-t2">Tier 2</span></td><td><b>20-EMA Pullback</b></td><td>Framework backbone</td><td class="num" style="color:var(--cyan)">42–48%</td><td class="num">+2.2R</td><td class="num">2–10d</td><td class="num">2–5/wk</td><td>Trend-continuation. 2:1 R:R compensates for low WR.</td></tr>
          </tbody>
        </table>
        </div>
        <div class="guide-warn"><b>Higher win rate ≠ bigger profit.</b> RSI(2) wins 75–85% but gains only 1–3% per trade. VCP wins 55–68% but gains 10–30%. 20-EMA Pullback wins 42–48% but uses 2:1 reward/risk, so each winner is ~2.2× the loser. Best results come from <b>stacking via Composite A+</b>.</div>
        <div class="guide-pass">
          <b>Recommended path for new users:</b>
          <ol>
            <li><b>Weeks 1–4 (paper):</b> Trade only <b>Composite A+</b> setups. Learn the workflow on rare, high-conviction trades.</li>
            <li><b>Weeks 5–8 (paper):</b> Add <b>RSI(2)</b> as your bread-and-butter. Short hold, many trades, fast feedback.</li>
            <li><b>Weeks 9–12 (paper):</b> Add <b>Gap-and-Go</b> and (if you have FMP) <b>PEAD</b> during earnings season.</li>
            <li><b>After 30+ paper trades:</b> Go live with a small cap ($1–2k/trade). Add Tier 2 strategies only after 100+ trades.</li>
          </ol>
        </div>
      </section>

      <section class="guide-section" id="g-start">
        <h2>1 — Quick start (5 minutes)</h2>
        <div class="guide-warn"><b>Educational tool only.</b> Not financial advice. Paper-trade for at least 3 months before risking real money.</div>
        <p>This is a <b>short-term swing-trading terminal</b>. Hold 2–15 trading days. Buy strength on confirmed setups, sell on stop-loss or target. The single most useful filter is <b>Tier = A+</b> — those signals stack multiple independent edges.</p>
        <div class="guide-pass">
          <b>5-minute setup:</b>
          <ol>
            <li>Open the app after your market closes (US: ~4:30 PM ET; India: ~3:30 PM IST).</li>
            <li>Confirm the cron has run: <b>Dashboard</b> should show non-zero tile counts and a regime banner.</li>
            <li>Check the regime banner. <b>TRADEABLE</b> = green light. <b>GO TO CASH</b> = stand down.</li>
            <li>Open <b>Live Signals</b>. Click <b>RUN SCAN</b>. Filter by Tier = <b>A+</b>.</li>
            <li>On each A+ row: read the reason column, note the TP and SL, verify no earnings within 7 days at your broker.</li>
            <li>Click <b>☆</b> to track the trade. Place the order with your broker manually.</li>
          </ol>
        </div>
        <p><b>What you need:</b> a brokerage account that supports stop-loss orders, $5k+ capital (ideally $10–25k), no margin. Optional <a href="https://financialmodelingprep.com/" target="_blank" rel="noopener">FMP API</a> key (~$19/mo) unlocks PEAD, Insider, and Analyst Upgrade strategies.</p>
      </section>

      <section class="guide-section" id="g-workflow">
        <h2>2 — Daily workflow</h2>
        <div class="guide-step"><div class="num">1</div><div class="text"><b>End-of-day:</b> open the app. Verify Dashboard regime is <b>TRADEABLE</b>.</div></div>
        <div class="guide-step"><div class="num">2</div><div class="text"><b>Scan A+ first.</b> Live Signals → run scan → filter Tier = <b>A+</b>. If 1–3 setups appear, these are your priority.</div></div>
        <div class="guide-step"><div class="num">3</div><div class="text"><b>Fall back to Tier 1.</b> If no A+, look at RSI(2), PEG, or PEAD signals.</div></div>
        <div class="guide-step"><div class="num">4</div><div class="text"><b>Verify externally.</b> For each candidate: check earnings date on your broker. <b>Skip if earnings within 7 days.</b> Scan headlines for binary regulatory events.</div></div>
        <div class="guide-step"><div class="num">5</div><div class="text"><b>Place orders.</b> Use the exact entry/SL from the signal. Buy-stop orders for breakouts, limit orders for mean-reversion. Position size = 0.75% of equity ÷ (entry − SL).</div></div>
        <div class="guide-step"><div class="num">6</div><div class="text"><b>Next morning:</b> watch your order. Cancel if the stock gaps &gt;1% above the trigger price. Don't chase.</div></div>
        <div class="guide-step"><div class="num">7</div><div class="text"><b>Manage trades:</b> Set the SL the moment you fill. At +2R (price = entry + 2×(entry − SL)), sell half and move SL to breakeven. Trail the runner with HighSinceEntry − 2.5×ATR. Time-stop at 10 trading days.</div></div>
        <div class="guide-step"><div class="num">8</div><div class="text"><b>Track on My Trades.</b> The cron re-evaluates every open trade each pass and pushes a notification when TP or SL is hit.</div></div>
      </section>

      <section class="guide-section" id="g-tiers">
        <h2>3 — Tier system (A+ / Tier 1 / Tier 2)</h2>
        <p>Every detected signal is auto-classified by quality. Use this badge as your primary filter.</p>
        <ul>
          <li><span class="badge tier-aplus">A+</span> — Multiple top-shelf confluence factors all present (e.g. extreme RSI(2) plus 3-day decline; PEAD strong AND fresh; VCP with volume dry-up AND tight pivot; etc.). Historically the highest hit-rate signals. Rare by design.</li>
          <li><span class="badge tier-t1">Tier 1</span> — Strategy fires cleanly with all primary conditions met. Standard quality. The bulk of useful signals land here.</li>
          <li><span class="badge tier-t2">Tier 2</span> — Strategy fires but with caveats (setup armed without final confirmation, missing volume dry-up, weak trend backdrop). Worth watching, not necessarily worth a position.</li>
        </ul>
        <div class="guide-warn"><b>Tier ≠ guarantee.</b> Even A+ signals lose ~15% of the time. The edge is in <b>positive expectancy across many trades</b>, not certainty on any one.</div>
      </section>

      <section class="guide-section" id="g-tier1">
        <h2>4 — Tier 1 strategies <span style="color:var(--green)">(70%+ historical win rate)</span></h2>

        <div class="strategy-card good">
          <div class="name">RSI(2) Mean Reversion — Connors &amp; Alvarez (2008) — 75–85% win rate</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>Large caps (S&amp;P 500 / core)</b>. Mean-reversion needs stable, liquid names that reliably bounce — not volatile small caps.</td></tr>
            <tr><th>What</th><td>Buy a quality stock (above 200-SMA) when 2-period RSI drops below 10. Snaps back within 2–7 days.</td></tr>
            <tr><th>Why it works</th><td>Short-term oversold on healthy stocks attracts mean-reversion buying.</td></tr>
            <tr><th>Entry</th><td>Market order at next open, or limit at today's close. No buy-stop.</td></tr>
            <tr><th>Stop</th><td>Close − 1.5 × ATR(14) or 10-bar low × 0.99.</td></tr>
            <tr><th>Exit</th><td>Close &gt; 5-day SMA → sell all. Or RSI(2) &gt; 70. No fixed target.</td></tr>
            <tr><th>Hold</th><td>2–7 trading days. Most resolve in 3–5.</td></tr>
            <tr><th>Mistake</th><td>Holding past the 5-SMA cross for a "bigger move". The edge dies — take the small win.</td></tr>
          </table>
        </div>

        <div class="strategy-card good">
          <div class="name">PEAD — Post-Earnings Drift — Ball &amp; Brown (1968) — 75–80% — API required</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>Any cap with a real beat + liquidity</b>. The drift is strongest in <b>mid/small caps</b> (slower to be priced in), but large-cap beats are cleaner to trade.</td></tr>
            <tr><th>What</th><td>Stock beats earnings by &gt;5%, drifts upward for 60+ trading days.</td></tr>
            <tr><th>Why it works</th><td>Most-replicated anomaly in finance. Institutions can't rebalance instantly.</td></tr>
            <tr><th>Entry</th><td>Buy within 10 days of beat ("fresh"). Best on pullback to 20-EMA.</td></tr>
            <tr><th>Stop</th><td>Pre-earnings close, or close − 2 × ATR(14).</td></tr>
            <tr><th>Exit</th><td>Hold 30–60 days. Exit on 50-SMA break.</td></tr>
            <tr><th>Mistake</th><td>Buying without verifying the actual beat. Reiterated guidance &gt; raised guidance.</td></tr>
          </table>
        </div>

        <div class="strategy-card good">
          <div class="name">Gap-and-Go (PEG) — Minervini / Zanger — 65–72% win rate</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>Mid/small caps</b> with a real catalyst (more explosive gaps), plus liquid large caps. The move is bigger the smaller the cap — so is the risk.</td></tr>
            <tr><th>What</th><td>Stock gaps up ≥4% on ≥2× volume, holds above gap-open for 3+ days.</td></tr>
            <tr><th>Catalyst</th><td>The archetype is an <b>earnings beat + raised guidance</b> (hence "Power Earnings Gap"). Also: a major <b>analyst upgrade/initiation</b>, <b>FDA approval / trial data</b>, a big <b>contract / M&amp;A / product launch</b>, or index inclusion — anything that gaps the stock up on heavy volume. <b>⚠️ The scanner only sees the gap + volume, not the news.</b> Always look up <i>why</i> it gapped: a real earnings/fundamental catalyst = trade it; no clear news / a thin pump / a rumor = skip. A gap without a genuine catalyst tends to fade.</td></tr>
            <tr><th>Why it works</th><td>Massive gap on volume = institutional vote. Gap-open becomes new support.</td></tr>
            <tr><th>Entry</th><td>Buy pullback to gap-open area (within 2% above), or buy-stop above post-gap high.</td></tr>
            <tr><th>Stop</th><td><b>Gap-open × 0.98</b> — hard stop. If the gap fills, exit immediately.</td></tr>
            <tr><th>Exit</th><td>First target +2R sell 50%. Trail rest with 20-EMA.</td></tr>
            <tr><th>Mistake</th><td>Buying on the gap day at the top. Wait for the 3-day hold, then buy the pullback.</td></tr>
          </table>
        </div>
      </section>

      <section class="guide-section" id="g-tier2">
        <h2>5 — Tier 2 strategies <span style="color:var(--amber)">(55–75% win rate)</span></h2>
        <p>Solid edges but require more discretion or specific conditions. Best used as supplements to Tier 1.</p>
        <div class="guide-warn" style="text-align:left"><b>About the Exit rows:</b> they describe how the app's <b>automated settlement</b> grades each signal — trend/breakout strategies use a <b>trailing stop</b> (breakeven at +1R, trail 2R below the high, per-strategy max hold); mean-reversion uses its native exit (e.g. RSI2's close&gt;5-SMA). When you trade <b>manually</b> you can use the discretionary version (sell half at +2R, trail the rest — see §6 Position sizing). Selection/Entry/Stop rows are the exact engine rules.</div>

        <div class="strategy-card warn">
          <div class="name">VCP — Volatility Contraction (Minervini) — 55–68%, big winners</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>Mid-cap growth leaders (MidCap 400, some SmallCap 600)</b>. This is a classic growth-leader pattern — large caps rarely form clean VCPs or run far enough.</td></tr>
            <tr><th>What</th><td>Uptrend stock builds a base of 3+ progressively tighter contractions while volume dries up, then breaks out.</td></tr>
            <tr><th>Selection</th><td>Above the 150- &amp; 200-SMA, ≤25% off the 52-week high, 3 windows of contracting range (each ≥10% tighter than the prior), volume drying up (late-base &lt;65% of early-base), price within 8% of the pivot.</td></tr>
            <tr><th>Entry</th><td>Buy-stop just above the pivot (last contraction high) on the breakout, volume ≥ 1.5× average.</td></tr>
            <tr><th>Stop</th><td>Pivot − 1.5 × ATR(14).</td></tr>
            <tr><th>Exit</th><td>Trailing stop (breakeven at +1R, trail 2R below the high); max hold 25 days. No fixed target — let the breakout run.</td></tr>
          </table>
        </div>
        <div class="strategy-card warn">
          <div class="name">High Tight Flag — O'Neil — 65–75%, 50–300% gains, extremely rare</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>Small/mid caps (SmallCap 600, MidCap 400)</b>. Doubling in 8 weeks basically never happens in large caps — this is a small-cap-rocket pattern.</td></tr>
            <tr><th>What</th><td>Stock doubles (+100%) in ≤ 8 weeks, then forms a tight (&lt;25% deep) flag for 5+ days.</td></tr>
            <tr><th>Selection</th><td>+100% move from base low to peak within ≤8 weeks, then a flag &lt;25% deep lasting ≥5 bars, price still in the flag zone.</td></tr>
            <tr><th>Entry</th><td>Buy-stop just above the flag/peak high.</td></tr>
            <tr><th>Stop</th><td>Flag low × 0.99.</td></tr>
            <tr><th>Exit</th><td>Trailing stop (breakeven at +1R, trail 2R below the high); max hold 40 days.</td></tr>
            <tr><th>Frequency</th><td>0–3 per year. Worth knowing about, never the bulk of your activity.</td></tr>
          </table>
        </div>
        <div class="strategy-card warn">
          <div class="name">Pocket Pivot — Kacher &amp; Morales — 55–65% win rate</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>Mid-cap growth leaders (MidCap 400)</b>. It's an early-continuation signal for the same names that form VCPs.</td></tr>
            <tr><th>What</th><td>Up-day where volume exceeds the highest down-day volume of the prior 10 sessions. Stock near 10/50-SMA.</td></tr>
            <tr><th>Selection</th><td>Close &gt; open (up day); within 3% of the 10- or 50-SMA; above the 50-SMA; today's volume &gt; the highest down-day volume of the last 10 sessions.</td></tr>
            <tr><th>Entry</th><td>Buy at the close of the pocket-pivot day (or next open).</td></tr>
            <tr><th>Stop</th><td>The 10-SMA (if it's below price), else close − 1.5 × ATR(14).</td></tr>
            <tr><th>Exit</th><td>Trailing stop (breakeven at +1R, trail 2R below the high); max hold 15 days.</td></tr>
            <tr><th>Stacks</th><td>Pocket pivot inside a VCP base = very high probability.</td></tr>
          </table>
        </div>
        <div class="strategy-card warn">
          <div class="name">52-Week High Breakout — Jegadeesh &amp; Titman (1993) — 60–65%, medium-term</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>MidCap 400 / SmallCap 600</b> (and S&amp;P 500). Mid/small caps make far more frequent and explosive new highs — filter the Index to mid/small for this one.</td></tr>
            <tr><th>What</th><td>New 52-week high on above-average volume, above the 200-SMA.</td></tr>
            <tr><th>Selection</th><td>Today's high prints a fresh 52-week high; today's volume &gt; the 20-day average volume; close above the 200-SMA. <b>STRONG</b> when volume &gt; 1.5× average. <b>No RSI</b> — momentum breakouts filter on trend + volume (RSI is the separate mean-reversion strategy).</td></tr>
            <tr><th>Entry</th><td>At the close — but only if today's high ≥ 1.005× the prior 52-week high AND the close holds above it (rejects bare-margin fake-outs / bad data).</td></tr>
            <tr><th>Stop</th><td>Close − 2 × ATR(14).</td></tr>
            <tr><th>Exit</th><td>Trailing stop — breakeven at +1R, then trail 2R below the highest high; no fixed target; max hold 30 days. (Documented horizon 60–120 days — a position-trade, not a swing.)</td></tr>
          </table>
        </div>
        <div class="strategy-card warn">
          <div class="name">Insider Cluster — Lakonishok &amp; Lee (2001) — 65–75% — API required</div>
          <table class="kv">
            <tr><th>Best for</th><td><b>Small/mid caps (SmallCap 600, MidCap 400)</b>. Insider buying is a stronger signal in smaller companies (insiders have a real information edge there).</td></tr>
            <tr><th>What</th><td>≥ 2 unique corporate insiders bought their own stock within 30 days. ≥ 3 = STRONG cluster.</td></tr>
            <tr><th>Selection</th><td>≥ 2 unique insiders with open-market purchases in 30 days (≥ 3 = STRONG); quality/trend filter (above 200-SMA).</td></tr>
            <tr><th>Entry</th><td>At the close once the cluster is detected.</td></tr>
            <tr><th>Stop</th><td>Close − 1.5 × ATR(14).</td></tr>
            <tr><th>Exit</th><td>Fixed +15% target or 60-day time stop (slow drift, not a trailing breakout). Patient hold: 30–90 days.</td></tr>
            <tr><th>Why</th><td>Strongest information signal in financial economics.</td></tr>
          </table>
        </div>
      </section>

      <section class="guide-section" id="g-sizing">
        <h2>6 — Position sizing &amp; risk</h2>
        <table class="kv">
          <tr><th>Risk per trade</th><td><b>0.75% of equity</b>. On $10k account → max loss per trade = $75.</td></tr>
          <tr><th>Position size</th><td>$ risk ÷ (entry − stop). Example: entry $100, SL $97 → risk $3/share → with $75 risk budget, buy 25 shares ($2,500 notional).</td></tr>
          <tr><th>Cash cap</th><td>≤ <b>25% of equity per position</b>. Don't let one stock blow up your account.</td></tr>
          <tr><th>Portfolio heat</th><td>≤ <b>3.0%</b>. Sum of open initial-stop risk across all positions.</td></tr>
          <tr><th>Max positions</th><td>5 concurrent. Max 2 per sector.</td></tr>
          <tr><th>First target</th><td>+2R (price = entry + 2 × (entry − SL)). Sell 50%, move SL to breakeven.</td></tr>
          <tr><th>Trail</th><td>HighSinceEntry − 2.5 × ATR(14), ratchet only up.</td></tr>
          <tr><th>Time stop</th><td>10 trading days. Exit at the open of day 11 regardless of P/L.</td></tr>
        </table>
      </section>

      <section class="guide-section" id="g-regime">
        <h2>7 — Market regime</h2>
        <p>Three daily checks on the broad market:</p>
        <ol>
          <li><b>Index &gt; 200-SMA</b> — Long-term trend (10 months of closing prices). Above = uptrend intact.</li>
          <li><b>Index &gt; 50-SMA</b> — Medium-term trend (~2.5 months). Catches shifts the slow 200-SMA misses.</li>
          <li><b>VIX &lt; 25</b> (US) or <b>India VIX &lt; 20</b> — Volatility / "fear" gauge. Below threshold = calm.</li>
        </ol>
        <p><b>TRADEABLE</b> = at least 3 pass AND both trend gates pass. Trade normally.<br>
        <b>CAUTION</b> = mixed. Smaller size, A+ only.<br>
        <b>GO TO CASH</b> = 200-SMA fails, or VIX panic, or 2+ checks fail. Don't open new longs.</p>
      </section>

      <section class="guide-section" id="g-design">
        <h2>◆ Strategy design notes (FAQ)</h2>

        <h3>Why is the momentum breakout a 52-week high — not a 20- or 50-day high?</h3>
        <p>Because the <b>52-week high is the best-supported breakout lookback</b>, and shorter ones mostly add noise, not edge:</p>
        <ul>
          <li><b>Strongest evidence.</b> George &amp; Hwang (2004), <i>"The 52-Week High and Momentum Investing"</i> — nearness to the 52-week high is one of the best momentum predictors there is.</li>
          <li><b>Real structural meaning.</b> A new 52-week high clears <b>all overhead supply</b> — nobody who bought earlier is underwater waiting to sell. A 20-day high doesn't carry that.</li>
          <li><b>Shorter breakouts are noisier, not better.</b> The 20-day high is the classic Turtle/Donchian entry — famously a <b>~30–40% win rate</b> that only worked via trailing stops and a few huge winners. Mechanized without that, short breakouts get chopped up in range-bound markets. A 50-day high is a middle ground, but…</li>
          <li><b>…the roster is already momentum-heavy.</b> 52WH, VCP, Pocket Pivot, Gap/PEG, Pullback and HTF are all momentum/breakout flavors. The system is <b>not short on momentum signals — it's short on momentum signals with proven edge.</b> Adding 20/50-day highs just piles on more correlated, unproven signals and makes it harder to tell what actually works.</li>
        </ul>
        <p><b>If a better momentum strategy is ever added, it won't be another lookback</b> — it'll be a different <i>kind</i> of momentum: a <b>relative-strength / 12-1 month ranking</b> (Jegadeesh-Titman — buy the strongest names vs. peers, excluding the last month). That's the most-documented momentum effect and it's <i>cross-sectional</i>, so it complements the breakout signals instead of duplicating them.</p>
        <div class="guide-warn"><b>Sequencing:</b> don't add new strategies until the corrected settlement (trailing-stop exits for trend strategies) shows which of the <i>existing</i> ones are actually profitable. More unproven signals = harder to find the edge, not easier.</div>

        <h3>Which stocks does it scan? (core vs broad universe)</h3>
        <p>The cron scans two universes, and <b>which one fits depends on the strategy</b>:</p>
        <ul>
          <li><b>Core</b> — ~50 curated liquid <b>large-cap blue chips</b>. Scanned frequently. Ideal for <b>mean-reversion</b> (RSI2, Quality Dip), which needs stable, liquid names that reliably bounce.</li>
          <li><b>Broad</b> — the full <b>S&amp;P universe: S&amp;P 500 (large) + MidCap 400 + SmallCap 600</b> (~1,500 names), scanned once daily after the close. This is where the <b>breakout/momentum</b> strategies (52WH, VCP, HTF, Pocket Pivot) find real new-high leaders — large caps rarely break out hard.</li>
        </ul>
        <p>Every signal is tagged with its index (S&amp;P 500 / MidCap 400 / SmallCap 600) plus a <b>Large Cap</b> flag for the curated large-cap watchlist, so on <b>Live Signals</b> and <b>Signal History</b> you can use the <b>Index filter</b> (multi-select) to scope to a cap range — e.g. filter to <b>MidCap 400 / SmallCap 600</b> when hunting momentum, or <b>Large Cap / S&amp;P 500</b> for mean-reversion. The "Best for" row on each strategy below says which cap suits it.</p>
      </section>

      <section class="guide-section" id="g-mistakes">
        <h2>8 — Common mistakes</h2>
        <ul>
          <li><b>Trading without a stop.</b> Set the SL the moment you fill. No exceptions.</li>
          <li><b>Trading through earnings.</b> Skip any setup whose company reports within 7 days.</li>
          <li><b>Holding mean-reversion trades for "the big move".</b> RSI(2) edge dies after 5-SMA cross.</li>
          <li><b>Oversizing on A+.</b> "High probability" still means losses happen. Stick to 0.75% risk.</li>
          <li><b>Chasing gaps.</b> If the stock gaps &gt; 1% above your buy-stop, cancel and move on.</li>
          <li><b>Trading in a GO TO CASH regime.</b> The system is telling you not to. Listen.</li>
          <li><b>Ignoring sector concentration.</b> Five tech longs all crash together if NQ rolls over.</li>
        </ul>
      </section>

      <section class="guide-section" id="g-paper">
        <h2>9 — Paper trade first</h2>
        <p>Before risking real money:</p>
        <ol>
          <li>Use a paper-trade account at your broker (most offer one free).</li>
          <li>Track 30+ trades end-to-end through this app (★ them on Signal History, watch them settle).</li>
          <li>Verify your hit rate roughly matches the documented win rates above.</li>
          <li>Verify your average winner ≥ 1.5× your average loser.</li>
          <li>Only then go live, starting at $1–2k notional per trade.</li>
        </ol>
      </section>

      <section class="guide-section" id="g-glossary">
        <h2>10 — Glossary</h2>
        <table class="kv">
          <tr><th>200-SMA</th><td>200-day Simple Moving Average. Average closing price of the last 200 trading days (~10 months). The most-watched long-term trend line in stocks.</td></tr>
          <tr><th>50-SMA</th><td>50-day SMA. Medium-term trend.</td></tr>
          <tr><th>20-EMA</th><td>20-day Exponential Moving Average. Weights recent days more. Often acts as a moving stop/support in trending stocks.</td></tr>
          <tr><th>ATR(14)</th><td>14-day Average True Range. Measures average daily volatility in dollars. Used to size stops.</td></tr>
          <tr><th>RSI(2)</th><td>2-period Relative Strength Index. Very short-term oscillator. Below 10 = extreme oversold.</td></tr>
          <tr><th>VIX</th><td>CBOE Volatility Index — implied volatility from S&amp;P 500 options. "Fear gauge."</td></tr>
          <tr><th>India VIX</th><td>Same idea but derived from NIFTY options.</td></tr>
          <tr><th>52-week high</th><td>Highest intraday price over the last 252 trading days.</td></tr>
          <tr><th>R</th><td>"R-multiple". One unit of risk = entry − stop. A +2R trade = profit twice your risk.</td></tr>
          <tr><th>R:R</th><td>Reward:risk ratio. 2:1 means target is twice as far from entry as the stop.</td></tr>
          <tr><th>TP / SL</th><td>Take-profit / stop-loss price levels stored with each signal.</td></tr>
          <tr><th>Gap-and-Go</th><td>Stock gaps up on volume, holds the gap, and continues higher.</td></tr>
          <tr><th>PEAD</th><td>Post-Earnings Announcement Drift. Stocks that beat estimates drift in that direction for 60+ days.</td></tr>
          <tr><th>VCP</th><td>Volatility Contraction Pattern (Minervini). Series of tighter ranges with drying volume leading to a breakout.</td></tr>
          <tr><th>Chandelier exit</th><td>Trailing stop at HighSinceEntry − N×ATR. Ratchets up as price advances.</td></tr>
          <tr><th>Heat (portfolio)</th><td>Sum of (entry − stop) × shares across all open positions. Risk budget at the portfolio level.</td></tr>
        </table>
      </section>
    </div>
  `;

  // Smooth-scroll TOC links
  root.querySelectorAll('.guide-toc a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      const target = root.querySelector('#' + id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}
