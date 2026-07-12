// Condor Guide — the strategy rulebook behind the Condor Desk tab.
// Two modes: the classic managed 30–45 DTE condor (default; per the
// daystoexpiry.com entry/exit playbook) and the 1-DTE weekly translation of
// Sharique Samsudheen's "1% Atishaktam" Nifty strategy.
// Longer-form 1-DTE derivation: docs/us-weekly-iron-condor-rules.md.

export function renderCondorGuide(root) {
  root.innerHTML = `
    <div class="view guide-view">
      <h1>Condor Guide</h1>
      <p class="subtitle">S&amp;P iron condors, two ways — what each rule is, why it exists, and how the <a href="#/condor-desk" style="color:var(--cyan)">Condor Desk</a> computes your legs.</p>

      <div class="guide-warn" style="text-align:left">
        <b>Educational only — not financial advice.</b> Option selling has a high win rate and rare-but-real large losses. Paper-trade at least 4 cycles first, size by the rules, and never skip an exit rule.
      </div>

      <section class="guide-section">
        <h2>The strategy in one paragraph</h2>
        <p>An iron condor <b>sells</b> an out-of-the-money call and an out-of-the-money put on the S&amp;P 500 (collecting premium), and <b>buys</b> a further-out call and put as fixed protection. If the index stays between the short strikes — which it usually does — the position decays in your favor and you keep the credit. The four legs, entry timing, exits and sizing are all mechanical; the only real skill is following the exit rules without negotiating with yourself.</p>
      </section>

      <section class="guide-section">
        <h2>Choose your expiry: 35–40 DTE (default) or 1 DTE weekly</h2>
        <p>Days-to-expiry is the biggest design decision in a condor — it changes the credit, the pace of decay, the gamma risk, and how often you must look at the screen. The Desk supports both regimes as complete, separate rulebooks:</p>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th></th><th><b>30–45 DTE · managed</b> (default — enter ~35–40)</th><th><b>1 DTE · weekly</b> (the source "1%" strategy)</th></tr></thead>
          <tbody>
            <tr><td><b>Short strikes</b></td><td>0.15–0.20 delta (~80–85% OTM probability/side)</td><td>0.06–0.12 delta (~90%+ OTM probability by tomorrow)</td></tr>
            <tr><td><b>Wings</b></td><td>~1.5% of spot beyond shorts</td><td>~0.65% of spot beyond shorts</td></tr>
            <tr><td><b>Exit — profit</b></td><td>Buy back at <b>50% of max profit</b></td><td>Hold to expiry, let it expire (XSP/SPX)</td></tr>
            <tr><td><b>Exit — time</b></td><td>Close/roll at <b>21 DTE</b> if target not hit</td><td>n/a (expires tomorrow)</td></tr>
            <tr><td><b>Exit — loss</b></td><td>Hard stop at <b>2× credit</b> loss (whole position)</td><td>Per-<i>side</i> stop at 3× that side's credit</td></tr>
            <tr><td><b>Historical win rate</b></td><td>~78–82% when managed by these rules</td><td>High weekly win rate; ≈ +1% win weeks / −1% stop weeks</td></tr>
            <tr><td><b>Attention needed</b></td><td>Once a day</td><td>Fixed morning routine + honor stops intraday</td></tr>
            <tr><td><b>Pros</b></td><td>Big credits, slow gamma, time to adjust, forgiving for beginners</td><td>Fast theta, weekly cash cycle, no multi-week exposure</td></tr>
            <tr><td><b>Cons</b></td><td>Capital tied up 2–4 weeks; CPI/NFP/FOMC land inside the window (the management rules are how you live with that)</td><td>High gamma near strikes; overnight gap can blow through the stop; zero tolerance for hesitation</td></tr>
          </tbody>
        </table>
        </div>
        <p class="muted">The 30–45 DTE rules follow the iron-condor entry/exit playbook at daystoexpiry.com (enter 30–45 DTE, ~15–25Δ shorts, close at 50% profit or 21 DTE, exit at 200% of credit loss — managed win rate ~78–82%). The 1-DTE rules are the US translation of Sharique Samsudheen's weekly Nifty system. <b>Start with 30–45 DTE</b>: it forgives mistakes; 1 DTE does not.</p>
      </section>

      <section class="guide-section">
        <h2>Why the S&amp;P index — not "stable stocks"</h2>
        <ul>
          <li><b>Gap risk is the only real enemy.</b> Even boring stocks gap 5–15% overnight on earnings, guidance or news — straight through any stop. A 500-stock index diversifies single-name news away.</li>
          <li><b>Liquidity:</b> SPX/SPY chains are the deepest option markets in the world; exits fill instantly at fair prices.</li>
          <li><b>Structure:</b> index options (SPX/XSP) are cash-settled and European — no early assignment — and taxed 60/40 (Section 1256).</li>
          <li><b>Daily expirations</b> make the 1-DTE cadence possible; single stocks mostly expire Fridays only.</li>
          <li>Pros who sell single-stock options are running a different strategy (covered calls / the wheel). Systematic income condors = index.</li>
        </ul>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Instrument</th><th>Style</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td><b>XSP</b> (Mini-SPX)</td><td>Cash, European</td><td><b>Recommended start.</b> No assignment risk; ~1/10 SPX size; on Webull.</td></tr>
            <tr><td><b>SPX</b></td><td>Cash, European</td><td>XSP × 10; best fee economics at scale.</td></tr>
            <tr><td><b>SPY</b></td><td>Physical, American</td><td>Fine, but <b>never hold short legs into expiry</b> — assignment/pin risk; close early.</td></tr>
          </tbody>
        </table>
        </div>
      </section>

      <section class="guide-section">
        <h2>"With US volatility, what are safe legs?"</h2>
        <p><b>Don't think in fixed distances — think in delta.</b> The Desk picks short strikes by delta (0.15–0.20 in managed mode, 0.06–0.12 in 1-DTE mode). Delta approximates the probability the option finishes in-the-money, so the strikes automatically move <i>further away when volatility is high</i> and closer when it's calm — the safety margin stays constant no matter what VIX is doing.</p>
        <p>Guards on top of delta:</p>
        <ul>
          <li><b>Minimum credit rule:</b> if a side can't collect its credit floor at the target delta, premium is too thin to pay for the risk — <b>skip the entry</b>. Never move strikes closer to force a credit.</li>
          <li><b>Liquidity screen:</b> the Desk flags thin open interest and wide bid/ask markets on any leg.</li>
          <li><b>Event awareness:</b> in 1-DTE mode, first-Friday expiries are flagged (NFP 8:30 AM ET). In 30–45 DTE mode macro prints inside the window are unavoidable — that's what the 50%-profit / 21-DTE / 2×-credit exits are for.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>The managed 30–45 DTE playbook (default mode)</h2>
        <ol>
          <li><b>Enter</b> any day, targeting the listed expiry closest to ~38 DTE (accept 30–45).</li>
          <li><b>Sell</b> the ~0.16Δ call and ~0.16Δ put; <b>buy</b> wings ~1.5% of spot further out. Same width both sides.</li>
          <li><b>Credit check:</b> each side ≥ 0.25% of spot; the Desk also shows credit as % of width — mid-to-high 20s% is typical.</li>
          <li><b>Size:</b> defined risk (width − credit) ≤ 20% of capital per trade (configurable — lower is better).</li>
          <li><b>Manage by three exits, first one wins:</b>
            <ul>
              <li><b>Profit:</b> buy everything back at 50% of max profit (GTC order the moment you're filled).</li>
              <li><b>Time:</b> close (or roll to the next cycle) at 21 DTE regardless of P&amp;L.</li>
              <li><b>Loss:</b> hard stop when total loss = 2× the credit received.</li>
            </ul>
          </li>
          <li><b>Journal it.</b> Managed this way the win rate historically runs ~78–82% — but only with all three exits honored.</li>
        </ol>
      </section>

      <section class="guide-section">
        <h2>The 1-DTE weekly playbook (the source strategy)</h2>
        <ol>
          <li><b>Thu ~10:00 AM ET</b>: compute legs for Friday's expiry; sell ~0.09Δ call + put, wings 0.65% out. Skip if a side's credit &lt; 0.025% of spot or expiry is an NFP Friday.</li>
          <li>Place as one net-credit order; set alerts at the two per-side stop marks (4× each side's credit).</li>
          <li><b>If an alert fires</b>: close that entire side immediately. The other side stays.</li>
          <li><b>Fri 3:30 PM ET</b>: XSP/SPX safely OTM → let it cash-settle. SPY → close whatever remains.</li>
          <li>The math: win weeks +2 credits ≈ +1% of allocation; a stopped week −3 +1 ≈ −1%. Per-side risk is 3:1 but the structure is ~1:1 weekly with a high win rate. A gap through the stop ≈ −10% of allocation (rare, real, and the reason sizing is a rule, not a suggestion).</li>
        </ol>
      </section>

      <section class="guide-section">
        <h2>Reading the Desk's trade card like a trader</h2>
        <ul>
          <li><b>Mid vs natural credit:</b> "mid" assumes you get filled between bid and ask (usual with patience on S&amp;P products); "natural" is the instant-fill worst case. Start your limit at mid; accepting below ~90% of mid or below natural means the edge is gone — requote.</li>
          <li><b>Credit as % of width:</b> the risk/reward gauge. Managed mode typically ~25–35%; 1-DTE mode is thinner (~4–8%) because the probability is much higher.</li>
          <li><b>Profit zone / breakevens:</b> where you stand at expiry. The card shows how much room spot has to each breakeven.</li>
          <li><b>|Δ| column:</b> the short legs should sit inside your configured band; the wings are just insurance — their delta doesn't matter.</li>
          <li><b>OI column + liquidity warnings:</b> thin open interest or wide markets on a leg = worse fills; usually one strike over fixes it.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Webull specifics</h2>
        <ul>
          <li>You need <b>Level 3</b> options approval (spreads) — Level 2 can't open condors.</li>
          <li>Order entry: Options chain → pick the expiry from the Desk ticket → strategy <b>Iron Condor</b> (or 4-leg custom) → the four strikes → <b>net credit limit</b> starting at the mid credit → day order. After the fill, immediately place the GTC buy-back order at the profit-target mark (managed mode).</li>
          <li>Index options (XSP/SPX) carry a small per-contract fee; SPY options are commission-free (regulatory fees only).</li>
          <li>The Desk's chain is ~15-min delayed (CBOE public feed). Delta-picked strikes barely move in 15 minutes — but always sanity-check the live credit in Webull; if it's far off, recompute.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>The one non-negotiable</h2>
        <div class="guide-warn" style="text-align:left">
          When an exit rule triggers — profit target, 21 DTE, loss stop, per-side stop — <b>execute it</b>. No "there's resistance just above", no waiting for a bounce. Near a short strike, delta and gamma are large; a few extra points of hope can erase a quarter's profits. High-win-rate systems die from exactly one behaviour: not taking the small loss.
        </div>
      </section>
    </div>
  `;
}
