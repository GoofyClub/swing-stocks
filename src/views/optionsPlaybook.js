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
        <h2>Is this the "right" approach? (honest answer)</h2>
        <p>The <b>framework</b> here is genuinely what experienced options traders use — and it's principled, not random:</p>
        <ul>
          <li><b>Match the structure to the edge:</b> sell premium on high-probability/small-move setups, buy directional on big-move setups. This is standard.</li>
          <li><b>Premium selling</b> (cash-secured puts, the "wheel", credit spreads) is the statistically friendlier retail approach — most retail option <i>buyers</i> lose to theta + volatility crush. That's why the high-WR signals point to <i>selling</i>.</li>
          <li><b>Standard best practices:</b> match DTE to the hold, prefer ATM/ITM for steadier delta, take ~50% profit on short premium, cut losers before theta accelerates.</li>
        </ul>
        <p>What it is <b>not</b>: the exact strikes/DTE are <b>sensible conventions, not backtested-optimal numbers for your specific signals.</b> Three honest caveats:</p>
        <ul>
          <li><b>"2 strikes above ATM" (OTM calls)</b> is the <i>speculative</i> end — cheap, but low win-rate lottery tickets that decay fast. For most people, <b>ATM/ITM is better risk-adjusted.</b> OTM only when you specifically want a small-cost home-run swing.</li>
          <li><b>Edge must exist first.</b> Options amplify the underlying signal's edge — or lack of it. Until the (now-corrected) stock settlement shows a strategy is actually profitable, applying options to it just loses faster.</li>
          <li><b>Implied volatility is the dimension this table ignores</b> — and it's arguably the biggest driver of options profit (see below).</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Implied volatility — don't skip this</h2>
        <p>Whether an options trade is profitable depends as much on <b>IV</b> as on direction:</p>
        <ul>
          <li><b>Buying</b> (calls): you want <b>low/normal IV</b>. Buying calls when IV is high (e.g. right before earnings) means overpaying — even a correct move can lose to "IV crush" afterward. Check <b>IV rank/percentile</b>; avoid buying when it's elevated.</li>
          <li><b>Selling</b> (puts/spreads): you want <b>high IV</b> — you collect richer premium, and the edge improves when IV is elevated and likely to fall.</li>
          <li><b>Earnings</b> (PEG/PEAD): IV is highest into the report and collapses after. Buying calls <i>before</i> earnings is the classic trap; the drift play is usually <i>after</i> the print.</li>
        </ul>
        <p class="muted">The app doesn't pull options/IV data, so these are checks to do in your broker before placing the trade.</p>
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
