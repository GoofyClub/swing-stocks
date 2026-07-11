// Condor Guide — the strategy rulebook behind the Condor Desk tab. A US-market
// translation of Sharique Samsudheen's "1% Atishaktam" weekly Nifty iron-condor
// strategy. Educational reference; the Desk tab automates the leg math.
// Longer-form version: docs/us-weekly-iron-condor-rules.md.

export function renderCondorGuide(root) {
  root.innerHTML = `
    <div class="view guide-view">
      <h1>Condor Guide</h1>
      <p class="subtitle">The weekly 1-DTE S&amp;P iron condor — what it is, why each rule exists, and how the <a href="#/condor-desk" style="color:var(--cyan)">Condor Desk</a> computes your legs.</p>

      <div class="guide-warn" style="text-align:left">
        <b>Educational only — not financial advice.</b> Option selling has a high win rate and rare-but-real large losses (overnight gaps). Paper-trade at least 4 weekly cycles first, size by the rules, and never skip a stop.
      </div>

      <section class="guide-section">
        <h2>The strategy in one paragraph</h2>
        <p>Every week, one day before expiry, sell an iron condor on the S&amp;P 500: <b>sell</b> a far out-of-the-money call at a level the index is very unlikely to reach by tomorrow, <b>buy</b> a cheaper call further out as protection, and mirror the same on the put side. All four options expire tomorrow; time decay (theta) is at its fastest, so if the index stays inside your strikes — which it does most weeks — the whole structure decays to zero and you keep the credit: about <b>1% of allocated capital per week</b>. If the market runs at one side, a hard stop cuts that side at 3× its credit while the other side keeps its credit, capping a normal losing week at about −1%.</p>
        <p class="muted">Source: Sharique Samsudheen's "1% Atishaktam" Nifty strategy (weekly Wed→Thu 1-DTE condor, ₹8–10 premium shorts, 150-pt wings, ~₹6/side credit, 3× per-side stop). Everything below is that system scaled to US products as a % of spot.</p>
      </section>

      <section class="guide-section">
        <h2>Why the S&amp;P index — not "stable stocks"</h2>
        <ul>
          <li><b>Gap risk is the only real enemy.</b> Even boring stocks gap 5–15% overnight on earnings, guidance or news — straight through any stop. A 500-stock index diversifies single-name news away. (The source strategy uses Nifty — an index — for the same reason.)</li>
          <li><b>Liquidity:</b> SPX/SPY chains are the deepest option markets in the world; you can exit a stopped side instantly at a fair price.</li>
          <li><b>Structure:</b> index options (SPX/XSP) are cash-settled and European — no early assignment, no shares appearing in your account — and are taxed 60/40 (Section 1256).</li>
          <li><b>Daily expirations</b> make the 1-DTE cadence possible; most stocks only expire Fridays.</li>
          <li>Pros who sell single-stock options are running a different strategy (covered calls / the wheel). Systematic income condors = index.</li>
        </ul>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Instrument</th><th>Style</th><th>Capital / condor</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td><b>XSP</b> (Mini-SPX)</td><td>Cash, European</td><td>~$3.5–4k</td><td><b>Recommended start.</b> No assignment risk; can expire safely; on Webull.</td></tr>
            <tr><td><b>SPX</b></td><td>Cash, European</td><td>~$35–40k</td><td>XSP × 10; best fee economics at scale.</td></tr>
            <tr><td><b>SPY</b></td><td>Physical, American</td><td>~$3.5–4k</td><td>Fine, but <b>must close all legs by 3:30 PM ET expiry day</b> — assignment/pin risk.</td></tr>
          </tbody>
        </table>
        </div>
      </section>

      <section class="guide-section">
        <h2>"With US volatility, what are safe legs?"</h2>
        <p><b>Don't think in fixed distances — think in delta.</b> The Desk picks short strikes by <b>delta 0.06–0.12</b> (default target ≈ 0.09). Delta approximates the probability the option finishes in-the-money, so the strikes automatically move <i>further away when volatility is high</i> and closer when it's calm — the "safety" stays constant (~90% win rate per side) no matter what VIX is doing. That's the mechanical version of the source rule "ask where it won't go by expiry, then sell there."</p>
        <p>Two guards on top of delta:</p>
        <ul>
          <li><b>Minimum credit rule:</b> if a side can't collect ≥ 0.025% of spot at that delta, volatility is too low to pay for the risk — <b>skip the week</b>. Never move strikes closer to force a credit.</li>
          <li><b>Event filter:</b> skip (or shift to Mon→Tue) when FOMC, CPI, or NFP lands between entry and expiry. NFP is always a first-Friday 8:30 AM ET print — the Desk flags first-Friday expiries automatically; check a calendar for FOMC/CPI.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>The mechanical rules (what the Desk implements)</h2>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>#</th><th>Rule</th><th>Default</th><th>Why</th></tr></thead>
          <tbody>
            <tr><td>1</td><td><b>Schedule</b>: enter the morning before expiry, after 10:00 AM ET</td><td>Thu 10:00–10:30 ET → Fri expiry</td><td>1 DTE = peak theta; wait out the open's noise</td></tr>
            <tr><td>2</td><td><b>Event filter</b>: no FOMC/CPI/NFP between entry and expiry</td><td>skip or Mon→Tue</td><td>Scheduled news = scheduled gaps</td></tr>
            <tr><td>3</td><td><b>Short strikes</b>: |delta| band, beyond obvious S/R &amp; round numbers</td><td>0.06–0.12</td><td>Volatility-adaptive "won't reach" level</td></tr>
            <tr><td>4</td><td><b>Wings</b>: same width both sides, % of spot beyond shorts</td><td>0.65%</td><td>Defines max loss; scales the ₹150-pt Nifty wing</td></tr>
            <tr><td>5</td><td><b>Credit floor</b>: per-side net credit ≥ % of spot, sides balanced</td><td>0.025%</td><td>Else the reward doesn't pay for the risk — skip</td></tr>
            <tr><td>6</td><td><b>Sizing</b>: 1 condor per (total credit × 100 × 100) of capital</td><td>auto</td><td>Makes a win ≈ +1%, a stop ≈ −1%, a gap ≈ −10%</td></tr>
            <tr><td>7</td><td><b>Execution</b>: single 4-leg net-credit limit at mid; if legging, buys first</td><td>—</td><td>No naked-short moment; margin recognised</td></tr>
            <tr><td>8</td><td><b>Stop</b>: close a side when its spread mark ≥ (1 + mult) × its credit; other side stays on</td><td>3× loss (mark 4×)</td><td>Breathing room + hard cap; per-side, not combined</td></tr>
            <tr><td>9</td><td><b>Expiry</b>: XSP/SPX let it cash-settle if safely OTM at 3:30 ET; SPY always close by 3:30 ET</td><td>—</td><td>Assignment/pin risk exists only on SPY</td></tr>
            <tr><td>10</td><td><b>Journal every trade</b>, review every 12 weeks</td><td>Desk journal</td><td>The system only compounds if the ±1% profile holds</td></tr>
          </tbody>
        </table>
        </div>
      </section>

      <section class="guide-section">
        <h2>The math that makes it work</h2>
        <ul>
          <li><b>Winning week</b> (most weeks): both sides expire → keep <b>+2 credits ≈ +1%</b> of allocation.</li>
          <li><b>Stopped week</b>: one side loses 3 credits, the other keeps 1 → net <b>−2 credits ≈ −1%</b>.</li>
          <li>So each side individually risks 3:1, but the <i>structure</i> risks ~1:1 per week — with a high win rate. That asymmetry between per-side and whole-position risk is the entire engine of the strategy.</li>
          <li><b>Worst case</b> (gap through the stop overnight): defined risk = wing width − credit ≈ <b>−10% of allocation</b>. Rare (the author took −5% on the Russia–Ukraine open and still finished +40% that year) but it WILL eventually happen — that's why sizing (rule 6) is not optional.</li>
          <li><b>Realistic expectation:</b> 25–40%/yr on the allocation from base rules, before fees. Not a get-rich-quick machine; a discipline machine.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>A typical week, minute by minute</h2>
        <ol>
          <li><b>Thu ~10:00 AM ET</b> (coffee break): open Condor Desk → GET TODAY'S LEGS → check no red warnings → place the 4 legs in Webull as one iron-condor net-credit order at ≈ the quoted credit.</li>
          <li>Set two price alerts at the stop marks (the ticket lists them). Back to work.</li>
          <li><b>If an alert fires</b>: close that entire side (both legs, shorts first) at market. Leave the other side alone.</li>
          <li><b>Fri 3:30 PM ET</b>: XSP/SPX safely OTM → do nothing, it cash-settles. SPY → close whatever remains. First Friday of the month? You shouldn't be in the trade (NFP rule).</li>
          <li>Log the outcome in the Desk journal. Repeat next Thursday.</li>
        </ol>
      </section>

      <section class="guide-section">
        <h2>After 3 months of clean execution — the discretion layer</h2>
        <p>The source is explicit: base rules alone earn modest returns; his 40–50% years came from judgment layered on top. Earn these upgrades with reps first:</p>
        <ul>
          <li><b>Roll the winner closer:</b> when a short decays to ≤ 20% of its credit early, buy it back and re-sell nearer (same expiry/width) if it still passes the credit test.</li>
          <li><b>Re-enter after a stop:</b> once the move stalls at a level, sell a fresh spread further out on the stopped side — turns −1% weeks into −0.5%/breakeven/positive.</li>
          <li><b>Early profit-take:</b> close everything at ~80% of max profit if you prefer sleeping to squeezing the last 20%.</li>
        </ul>
        <div class="guide-warn" style="text-align:left">
          <b>The one non-negotiable:</b> when a stop mark trades, close the side. No "there's resistance just above", no waiting for a bounce. Near your short strike, delta and gamma are large — 30 extra points of hope can erase a quarter of profits. High-win-rate systems die from exactly one behaviour: not taking the small loss.
        </div>
      </section>

      <section class="guide-section">
        <h2>Webull specifics</h2>
        <ul>
          <li>You need <b>Level 3</b> options approval (spreads) — Level 2 can't open condors.</li>
          <li>Order entry: Options chain → strategy <b>Iron Condor</b> → pick the four strikes from the Desk ticket → <b>net credit limit</b> ≈ quoted credit (accept ≥ 90% of it) → day order.</li>
          <li>Index options (XSP/SPX) carry a small per-contract fee; SPY options are commission-free (regulatory fees only).</li>
          <li>The Desk's chain data is ~15-min delayed (CBOE public feed). Strikes chosen by delta barely move in 15 minutes — but always sanity-check the live credit in Webull before submitting; if it's far off, re-quote.</li>
        </ul>
      </section>
    </div>
  `;
}
