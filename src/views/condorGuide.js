// Condor Strategy Guide — UNDERSTAND the strategy the Desk implements.
// (How to operate the tool lives in the Desk Manual tab.)
// Sources: the consensus rules successful systematic condor sellers follow
// (tastytrade-style mechanics), the daystoexpiry.com entry/exit playbook, an
// external "safe iron condor blueprint", and Sharique Samsudheen's 1-DTE
// weekly Nifty system (mode two).

export function renderCondorGuide(root) {
  root.innerHTML = `
    <div class="view guide-view">
      <h1>Condor Strategy Guide</h1>
      <p class="subtitle">Understand the strategy the <a href="#/condor-desk" style="color:var(--cyan)">Condor Desk</a> runs — every rule, every number, and why. For button-by-button tool usage, see the <a href="#/condor-manual" style="color:var(--cyan)">Desk Manual</a>.</p>

      <div class="guide-warn" style="text-align:left">
        <b>Educational only — not financial advice.</b> Option selling wins often and loses rarely-but-bigger. The rules below are how disciplined traders keep the rare losses small. Paper-trade at least 4 cycles before real money.
      </div>

      <section class="guide-section">
        <h2>1. What an iron condor is</h2>
        <p>You are paid a <b>credit</b> for agreeing that the S&amp;P will stay inside a range for a few weeks. Four legs, all same expiry:</p>
        <pre style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:10px 14px;font-family:var(--font-mono);font-size:0.88rem;line-height:1.5">  [ Long Call  ]  ← wing: your insurance above (BUY)
  [ Short Call ]  ← ~0.15Δ, ~4% above spot (SELL — the ceiling)
        ▲
        │  profit zone: spot stays here → you keep the credit
        ▼
  [ Short Put  ]  ← ~0.15Δ, ~4% below spot (SELL — the floor)
  [ Long Put   ]  ← wing: your insurance below (BUY)</pre>
        <ul>
          <li><b>Max profit</b> = the net credit (shorts collected − wings paid). Happens if spot stays between the short strikes.</li>
          <li><b>Max loss</b> = wing width − credit. Fixed and known before entry — the wings make it impossible to lose more.</li>
          <li><b>Edge:</b> options at ~0.15 delta expire worthless ~85% of the time per side; you're selling that overpriced insurance and letting time decay (theta) pay you daily.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>2. What successful condor traders actually do — and how the Desk defaults match</h2>
        <p>Across the systematic premium-selling community the same mechanics repeat. These are the Desk's <b>defaults</b> (all tweakable):</p>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Rule</th><th>Consensus</th><th>Desk default</th></tr></thead>
          <tbody>
            <tr><td>Underlying</td><td>S&amp;P 500 products — liquidity + no single-stock gaps</td><td><b>SPY</b> (XSP/SPX selectable)</td></tr>
            <tr><td>Entry timing</td><td>~40 DTE (30–45 window)</td><td>Target <b>40 DTE</b>, snap to 30–45</td></tr>
            <tr><td>Short strikes</td><td>~0.15 delta (≈4% OTM), both sides</td><td>Delta band <b>0.12–0.18</b>, picks closest to 0.15</td></tr>
            <tr><td>Wings</td><td>Tight, consistent — e.g. $5 on SPY</td><td><b>0.75% of spot</b> (≈ $5 on SPY, scales automatically)</td></tr>
            <tr><td>Credit quality</td><td>≥ ~$1.00 on $5 wings (≈20% of width)</td><td>Skip if total credit &lt; <b>20% of width</b></td></tr>
            <tr><td>IV environment</td><td>Sell when volatility is elevated, stand aside when dead</td><td>VIX shown; warns below <b>13</b></td></tr>
            <tr><td>Profit exit</td><td><b>50% of max profit</b>, standing GTC buy-back</td><td>Exact buy-back mark on the card + ticket</td></tr>
            <tr><td>Time exit</td><td>Close/roll at <b>21 DTE</b> no matter what</td><td>Exact calendar date on the card</td></tr>
            <tr><td>Defense</td><td>Short strike delta hits ~0.30 → roll the <i>untested</i> side in</td><td>Defend note on card + ticket</td></tr>
            <tr><td>Loss exit</td><td>Hard stop at 2–3× credit</td><td>Mark = credit × 3 (loss = <b>2× credit</b>)</td></tr>
            <tr><td>Sizing</td><td><b>2–5% of portfolio</b> at risk per structure</td><td>Defined risk ≤ <b>5% of capital</b></td></tr>
            <tr><td>Frequency</td><td>Staggered entries every 1–2 weeks, not daily</td><td>Warns if an open condor is &lt; 7 days old</td></tr>
            <tr><td>Expected POP</td><td>~70–75% per trade; ~78–82% win rate managed</td><td>Est. POP computed from short deltas on every card</td></tr>
          </tbody>
        </table>
        </div>
        <p class="muted">Why these produce survivors: small size means no single trade matters; 50%-profit exits skip the dangerous late-gamma weeks; the 21-DTE rule caps time in the danger zone; the hard stop caps the tail; staggering means one bad market week can't hit every position at its worst.</p>
      </section>

      <section class="guide-section">
        <h2>3. Why the S&amp;P — not "stable stocks"</h2>
        <ul>
          <li><b>Gap risk is the only real enemy.</b> Even boring stocks gap 5–15% overnight on earnings/news — straight through any stop. 500 stocks diversify single-name news away.</li>
          <li><b>Liquidity:</b> SPY is the deepest option market on earth — penny-wide spreads, instant exits at fair prices. That's why the blueprint names it.</li>
          <li><b>Structure alternatives:</b> XSP/SPX are cash-settled European (no assignment risk) with 60/40 tax treatment — worth switching to as the account grows. SPY's one caveat: American-style, so never hold short legs into expiry (the 21-DTE rule means you never would anyway).</li>
          <li>Traders who sell single-stock options are running a different strategy (covered calls / the wheel), not systematic income condors.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>4. The volatility question: "what are safe legs?"</h2>
        <p><b>Think in delta, not distance.</b> A 0.15Δ short strike sits ~4% away in calm markets and ~7% away in wild ones — the chain reprices distance for you, keeping the probability of a breach roughly constant. That's why the Desk selects by delta band and why "safe" survives any VIX regime.</p>
        <ul>
          <li><b>When IV is high</b> (pullbacks, pre-CPI/Fed): strikes sit further out AND credits are fatter — the best time to sell. This is the blueprint's "optimal entry condition".</li>
          <li><b>When IV is dead</b> (VIX below ~13): credits are thin, the credit-vs-width floor fails, and the right move is to <b>wait</b> — the Desk warns instead of forcing strikes closer.</li>
          <li><b>Liquidity screen:</b> every leg is checked for thin open interest and wide bid/ask; a flagged leg usually means "move one strike over".</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>5. The lifecycle of one managed trade</h2>
        <ol>
          <li><b>Entry (day 0, ~40 DTE):</b> sell the ~0.15Δ call + put, buy wings 0.75% further out, collect ≥20%-of-width credit as one net-credit order. Immediately place the GTC buy-back at 50% of the credit.</li>
          <li><b>Most weeks:</b> nothing happens. Theta grinds the condor's price down. You check once a day.</li>
          <li><b>~60–70% of trades:</b> the GTC fills at 50% profit somewhere in weeks 1–3. Done. Log it. Wait for the stagger window, re-enter.</li>
          <li><b>If the market walks toward a short strike</b> (its delta reaching ~0.30): <i>defend</i> — buy back the far, now-nearly-worthless side for pennies and re-sell it at the new ~0.15Δ. The extra credit widens your loss cushion. (Optional — skipping defense and just honoring the exits is also a valid, simpler system.)</li>
          <li><b>21 DTE reached without the target:</b> close (or roll the whole condor to the next ~40 DTE cycle). Never ride into the last three weeks — that's where gamma lives.</li>
          <li><b>Hard stop</b> (condor mark ≥ 3× credit ≈ loss of 2× credit): exit everything, mechanically. No negotiating.</li>
        </ol>
        <p class="muted">Expected texture of results: many +$50-per-$100-credit wins, occasional −$200-ish stops, rare defended trades that end near flat. The win rate (~78–82% managed) plus small sizing is the whole business model.</p>
      </section>

      <section class="guide-section">
        <h2>6. The numbers on a typical SPY trade (defaults)</h2>
        <ul>
          <li>SPY at $680 → shorts ≈ $652 put / $708 call (~0.15Δ), wings $5 further ($647 / $713).</li>
          <li>Credit ≈ $1.00–1.25 → max profit ~$110; defined risk ≈ $5.00 − $1.10 ≈ $390 per contract.</li>
          <li>Sizing at 5% risk: one contract needs ≈ $7,800 of capital behind it.</li>
          <li>Profit exit at $0.55 mark (+$55); time exit ~19 days in; hard stop at $3.30 mark (−$220).</li>
          <li>Est. POP ≈ 70–75%. Expectancy comes from managing, not from any single trade.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>7. Mode two: the 1-DTE weekly system</h2>
        <p>The Desk's second mode is the strategy from the source video (Sharique's weekly Nifty "1%" system), translated to the S&amp;P: enter the morning before expiry (Thu→Fri), sell ~0.09Δ call + put with 0.65%-of-spot wings, hold to expiry, and stop a <i>side</i> if its loss hits 3× that side's credit. Win weeks ≈ +1% of allocation, stopped weeks ≈ −1%, gap-through-stop worst case ≈ −10%.</p>
        <p><b>When to use which:</b> the managed 30–45 DTE mode is the high-win-rate, low-attention system — learn on it. The 1-DTE mode is faster, needs a strict morning routine and instant stop discipline, and punishes hesitation. Same tool, same card, different rulebooks — switch modes in the config.</p>
      </section>

      <section class="guide-section">
        <h2>8. The one non-negotiable</h2>
        <div class="guide-warn" style="text-align:left">
          When an exit rule triggers — 50% target, 21 DTE, hard stop, per-side stop — <b>execute it</b>. No "there's support just below", no waiting for a bounce. Every number above only produces its historical win rate when the exits are taken mechanically. High-win-rate systems die from exactly one behaviour: not taking the small loss.
        </div>
      </section>
    </div>
  `;
}
