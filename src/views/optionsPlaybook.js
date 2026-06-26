// Options Playbook — plain-English "what to do" guidance for trading options off
// each stock signal. Rules only, no premiums/greeks/live chain. Find a signal's
// strategy on Live Signals, then follow its row here.
//
// MAINTENANCE: keep the per-strategy rows in sync with the strategy registry and
// the settlement model. This is educational guidance, not financial advice.

export function renderOptionsPlaybook(root) {
  root.innerHTML = `
    <div class="view guide-view">
      <h1>Options Playbook</h1>
      <p class="subtitle">For each stock signal, what to do with options — instrument, strike, expiry, and exit, in plain rules (no premiums or math). Look up the signal's <b>strategy</b> from <a href="#/signals" style="color:var(--cyan)">Live Signals</a> below.</p>

      <div class="guide-warn" style="text-align:left">
        <b>Educational only — not advice, and not automated.</b> Options can expire worthless; size small. The app does not place options orders (stock-only). Use these rules to trade options manually in your broker.
      </div>

      <section class="guide-section">
        <h2>Two playbooks, by signal character</h2>
        <p>Your strategies split into two families, and they call for <b>opposite</b> options approaches:</p>
        <ul>
          <li><b>High win-rate mean-reversion</b> (RSI2, Quality Dip): small, fast bounces. <b>Sell premium</b> — theta works for you. Buying calls here loses to time decay.</li>
          <li><b>Momentum / breakout</b> (52-Week High, Gap/PEG, VCP, Pullback, Pocket Pivot, HTF): larger, multi-week moves. <b>Buy calls</b> (or call spreads) — you need a big move, which these aim for.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Quick reference</h2>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr>
            <th>Strategy</th><th>Do</th><th>Strike</th><th>Expiry (DTE)</th><th>Enter when</th><th>Exit when</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><b>RSI2</b> <span class="badge tier-t1">mean-rev</span></td>
              <td><b>Sell</b> a cash-secured put (or bull-put spread)</td>
              <td>Put strike at/below the signal <b>SL</b> (out-of-the-money)</td>
              <td>7–21</td>
              <td>On the oversold signal</td>
              <td>Close at ~50% of max profit, or when the stock hits <b>TP</b>; close by expiry</td>
            </tr>
            <tr>
              <td><b>Quality Dip</b> <span class="badge tier-t1">mean-rev</span></td>
              <td><b>Sell</b> a cash-secured put (or bull-put spread)</td>
              <td>Put strike near/below the <b>SL</b></td>
              <td>14–30</td>
              <td>On the dip-reversal signal</td>
              <td>~50% profit, or stock reclaims <b>TP</b>; close by expiry</td>
            </tr>
            <tr>
              <td><b>52-Week High</b> <span class="badge tier-t2">momentum</span></td>
              <td><b>Buy</b> a call (or call debit spread to cut cost)</td>
              <td>ATM to 1 strike ITM (steady) — or 1–2 strikes OTM for more leverage/risk</td>
              <td>30–60</td>
              <td>When the breakout entry triggers</td>
              <td>Sell when the stock hits <b>TP</b> (or your trailing stop); cut if it hits <b>SL</b></td>
            </tr>
            <tr>
              <td><b>Gap-and-Go / PEG</b> <span class="badge tier-t2">momentum</span></td>
              <td><b>Buy</b> a call</td>
              <td>ATM to slightly ITM</td>
              <td>30–45</td>
              <td>Right after the gap holds / entry triggers</td>
              <td>Sell when stock hits <b>TP</b> or the pop stalls; cut at <b>SL</b></td>
            </tr>
            <tr>
              <td><b>VCP</b> <span class="badge tier-t2">momentum</span></td>
              <td><b>Buy</b> a call (or call debit spread)</td>
              <td>ATM to 1 strike ITM</td>
              <td>45–90 (base can take time)</td>
              <td>When price breaks the pivot (entry)</td>
              <td>Trail with the stock; sell into strength or hits <b>TP</b>; cut at <b>SL</b></td>
            </tr>
            <tr>
              <td><b>Pullback</b> <span class="badge tier-t2">momentum</span></td>
              <td><b>Buy</b> a call</td>
              <td>ATM to 1 strike ITM</td>
              <td>30–45</td>
              <td>When the buy-stop entry triggers</td>
              <td>Sell at <b>TP</b> / trailing stop; cut at <b>SL</b></td>
            </tr>
            <tr>
              <td><b>Pocket Pivot</b> <span class="badge tier-t2">momentum</span></td>
              <td><b>Buy</b> a call</td>
              <td>ATM to slightly ITM</td>
              <td>30–60</td>
              <td>On the pocket-pivot up day</td>
              <td>Sell at <b>TP</b> / trailing stop; cut at <b>SL</b></td>
            </tr>
            <tr>
              <td><b>High Tight Flag</b> <span class="badge tier-t2">momentum</span></td>
              <td><b>Buy</b> a call (home-run; small size)</td>
              <td>ATM or OTM for leverage</td>
              <td>60–120+ (give it room)</td>
              <td>On the flag breakout</td>
              <td>Scale out as it runs; trail; cut at <b>SL</b></td>
            </tr>
            <tr>
              <td><b>Monthly FVG</b> <span class="badge tier-t2">swing</span></td>
              <td><b>Buy</b> a longer-dated call</td>
              <td>ATM to slightly ITM</td>
              <td>90–180</td>
              <td>On the bullish reaction off the gap</td>
              <td>Sell at <b>TP</b> / trailing stop; cut at <b>SL</b></td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <section class="guide-section">
        <h2>How to read a strike (no math needed)</h2>
        <ul>
          <li><b>ATM</b> (at-the-money) = strike closest to the current price. Balanced cost vs. sensitivity.</li>
          <li><b>ITM</b> (in-the-money) = strike below price (for calls). Costs more, but moves more like the stock and decays slower — steadier.</li>
          <li><b>OTM</b> (out-of-the-money) = strike above price (for calls). Cheaper, more leverage, but needs a bigger move and decays faster. "<b>Buy 2 strikes above ATM</b>" = a more aggressive, lower-cost/higher-risk bet.</li>
          <li><b>DTE</b> = days to expiry. More DTE = less time-decay pressure (and more cost). Match DTE to the strategy's hold.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Universal exit rules</h2>
        <ul>
          <li><b>Buying calls:</b> sell when the stock hits the signal's <b>TP</b>, or when your trailing stop on the stock triggers. Cut the call if the stock hits the <b>SL</b>. Don't hold a losing call into expiry hoping — theta accelerates in the last 1–2 weeks.</li>
          <li><b>Selling puts:</b> you win as long as the stock stays above your put strike. Take profit early (≈50% of the credit) rather than holding to expiry. If the stock breaks the <b>SL</b>, close or roll — don't get assigned unintentionally.</li>
          <li><b>Always:</b> size by what you can lose (premium paid, or cash secured), not by share count.</li>
        </ul>
      </section>
    </div>
  `;
}
