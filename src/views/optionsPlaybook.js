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
          <li><b>⚠️ For PUTS it flips:</b> a put's <b>OTM</b> strike is <b>below</b> the price, and its <b>ITM</b> strike is <b>above</b> the price — the opposite of calls. So when <i>selling</i> a put "to be safe," you go <b>OTM = below the price</b> (see next section).</li>
          <li><b>DTE</b> = days to expiry. More DTE = less time-decay pressure (and more cost). Match DTE to the strategy's hold.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Selling puts safely (cash-secured put / the "wheel")</h2>
        <p>For the high win-rate mean-reversion signals (<b>RSI2, Quality Dip</b>), the conservative options play is to <b>sell an out-of-the-money put — a strike BELOW the current price</b>, near or below the signal's <b>SL</b>. You collect a premium and keep all of it as long as the stock stays above your strike.</p>
        <div class="guide-warn" style="text-align:left">
          <b>Common mistake:</b> selling an <b>ITM</b> put (strike <b>above</b> price) is <b>not</b> safe — it's already in-the-money, very likely to be assigned, and is the aggressive side. "Safe" = sell <b>OTM, below</b> the price.
        </div>
        <p>Strike ladder, stock at $100 (pick where on the dial you want to be):</p>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Put strike</th><th>vs price</th><th>Sell it?</th><th>Trade-off</th></tr></thead>
          <tbody>
            <tr><td>$106</td><td>ITM (above)</td><td style="color:var(--red)">✗ aggressive</td><td>Likely assigned; most premium, most risk</td></tr>
            <tr><td>$100</td><td>ATM</td><td style="color:var(--amber)">~50/50</td><td>Rich premium, coin-flip on assignment</td></tr>
            <tr><td>$95</td><td>OTM, near SL</td><td style="color:var(--green)">✓ typical "safe"</td><td>Good premium, high chance of keeping it</td></tr>
            <tr><td>$92</td><td>further OTM</td><td style="color:var(--green)">✓ safest</td><td>Highest win rate, smallest premium</td></tr>
          </tbody>
        </table>
        </div>
        <p><b>How to choose the strike:</b> put it at a chart support / your signal's <b>SL</b> level, or around <b>0.30 delta</b> (≈70% chance of keeping the full premium). Further below price = safer but less income; closer to price = more income but more risk.</p>
        <div class="guide-warn" style="text-align:left">
          <b>"Safe" = high win rate, NOT small max loss.</b> A cash-secured put still has large downside — if the stock craters you're obligated to buy at the strike (same risk shape as being long the stock). You win often, but the rare loss is big.
        </div>
        <p><b>To actually cap the loss — sell a bull-put SPREAD:</b> sell the $95 put <b>and buy a $90 put below it</b>. You collect less, but your max loss is fixed at the strike width minus the credit ($5 − credit here). This is the genuinely defined-risk version. (Spreads need a higher Alpaca options level than a plain cash-secured put.)</p>
        <p><b>Exit:</b> take profit early at ≈50% of the credit rather than holding to expiry; if the stock breaks your SL, close or roll — don't get assigned unintentionally.</p>
      </section>

      <section class="guide-section">
        <h2>Bull put spread — step-by-step execution guide</h2>
        <p>This is the <b>defined-risk</b> way to trade a bullish mean-reversion signal (RSI2, Quality Dip) with options: you <b>sell a put</b> (collect premium) and <b>buy a lower put</b> as a built-in stop-loss. Net <b>credit</b>; you win if the stock simply stays above your short strike; your max loss is capped no matter how far the stock falls.</p>

        <h3 style="color:var(--text-mute);font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 6px">The option chain, on the example signal (price $100, SL $95)</h3>
        <p class="muted">A broker chain lists CALLS on the left, PUTS on the right, strikes down the middle. Notice ITM/OTM <b>flip</b> between calls and puts. The two highlighted put strikes are the bull-put spread.</p>
        <div style="overflow-x:auto">
        <svg viewBox="0 0 680 372" width="100%" style="max-width:680px;display:block;margin:6px auto;font-family:var(--font-sans)">
          <text x="145" y="24" text-anchor="middle" fill="var(--text-mute)" font-size="13" letter-spacing="2">CALLS</text>
          <text x="340" y="24" text-anchor="middle" fill="var(--text-mute)" font-size="13" letter-spacing="2">STRIKE</text>
          <text x="535" y="24" text-anchor="middle" fill="var(--text-mute)" font-size="13" letter-spacing="2">PUTS</text>

          <!-- 110 : call OTM / put ITM -->
          <rect x="40" y="40" width="210" height="52" rx="5" fill="rgba(148,163,184,0.10)" stroke="var(--line-soft)"/>
          <text x="145" y="71" text-anchor="middle" fill="var(--text-mute)" font-size="13">OTM (above price)</text>
          <rect x="290" y="40" width="100" height="52" rx="5" fill="var(--bg-elev)" stroke="var(--line-soft)"/>
          <text x="340" y="72" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700">110</text>
          <rect x="430" y="40" width="210" height="52" rx="5" fill="rgba(74,222,128,0.12)" stroke="var(--line-soft)"/>
          <text x="535" y="71" text-anchor="middle" fill="var(--green)" font-size="13">ITM (above price)</text>

          <!-- 105 -->
          <rect x="40" y="98" width="210" height="52" rx="5" fill="rgba(148,163,184,0.10)" stroke="var(--line-soft)"/>
          <text x="145" y="129" text-anchor="middle" fill="var(--text-mute)" font-size="13">OTM</text>
          <rect x="290" y="98" width="100" height="52" rx="5" fill="var(--bg-elev)" stroke="var(--line-soft)"/>
          <text x="340" y="130" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700">105</text>
          <rect x="430" y="98" width="210" height="52" rx="5" fill="rgba(74,222,128,0.12)" stroke="var(--line-soft)"/>
          <text x="535" y="129" text-anchor="middle" fill="var(--green)" font-size="13">ITM</text>

          <!-- 100 : ATM / current price -->
          <rect x="40" y="156" width="210" height="52" rx="5" fill="rgba(34,211,238,0.10)" stroke="var(--cyan)"/>
          <text x="145" y="187" text-anchor="middle" fill="var(--cyan)" font-size="13" font-weight="600">ATM</text>
          <rect x="290" y="156" width="100" height="52" rx="5" fill="rgba(34,211,238,0.18)" stroke="var(--cyan)" stroke-width="2"/>
          <text x="340" y="181" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700">100</text>
          <text x="340" y="198" text-anchor="middle" fill="var(--cyan)" font-size="10">price ≈ entry</text>
          <rect x="430" y="156" width="210" height="52" rx="5" fill="rgba(34,211,238,0.10)" stroke="var(--cyan)"/>
          <text x="535" y="187" text-anchor="middle" fill="var(--cyan)" font-size="13" font-weight="600">ATM</text>

          <!-- 95 : call ITM / put OTM  → SELL (short leg) -->
          <rect x="40" y="214" width="210" height="52" rx="5" fill="rgba(74,222,128,0.12)" stroke="var(--line-soft)"/>
          <text x="145" y="245" text-anchor="middle" fill="var(--green)" font-size="13">ITM (below price)</text>
          <rect x="290" y="214" width="100" height="52" rx="5" fill="var(--bg-elev)" stroke="var(--green)" stroke-width="2"/>
          <text x="340" y="246" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700">95</text>
          <rect x="430" y="214" width="210" height="52" rx="5" fill="rgba(148,163,184,0.10)" stroke="var(--green)" stroke-width="2"/>
          <text x="445" y="237" fill="var(--text-mute)" font-size="11">OTM (below price)</text>
          <text x="445" y="256" fill="var(--green)" font-size="13" font-weight="700">▼ SELL $95 put (short)</text>

          <!-- 90 : call ITM / put OTM  → BUY (long / protection) -->
          <rect x="40" y="272" width="210" height="52" rx="5" fill="rgba(74,222,128,0.12)" stroke="var(--line-soft)"/>
          <text x="145" y="303" text-anchor="middle" fill="var(--green)" font-size="13">ITM</text>
          <rect x="290" y="272" width="100" height="52" rx="5" fill="var(--bg-elev)" stroke="var(--red)" stroke-width="2"/>
          <text x="340" y="304" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700">90</text>
          <rect x="430" y="272" width="210" height="52" rx="5" fill="rgba(148,163,184,0.10)" stroke="var(--red)" stroke-width="2"/>
          <text x="445" y="295" fill="var(--text-mute)" font-size="11">OTM</text>
          <text x="445" y="314" fill="var(--red)" font-size="13" font-weight="700">▲ BUY $90 put (protection)</text>

          <!-- spread bracket -->
          <path d="M656 216 q8 0 8 8 v82 q0 8 -8 8" fill="none" stroke="var(--amber)" stroke-width="1.5"/>
          <text x="668" y="268" fill="var(--amber)" font-size="11" transform="rotate(90 668 268)" text-anchor="middle">bull put spread</text>
        </svg>
        </div>
        <p class="muted"><b>Reading it:</b> for <b>calls</b>, ITM is below the price and OTM is above. For <b>puts</b> it's the opposite — ITM above, OTM below. Selling the <b>$95</b> put (OTM, below price) is the "safe" short leg; buying the <b>$90</b> put below it is the protective long leg that caps your loss.</p>

        <h3 style="color:var(--text-mute);font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 6px">Map the signal to two strikes</h3>
        <p>Take the signal's <b>entry</b> (≈ current price) and <b>SL</b>. Example: a signal with entry <b>$100</b>, SL <b>$95</b>.</p>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Leg</th><th>Action</th><th>Strike (from the signal)</th><th>Role</th></tr></thead>
          <tbody>
            <tr><td><b>Short put</b></td><td style="color:var(--green)">SELL to open</td><td>At/just below the <b>SL</b> ($95) — the level you believe holds (≈0.30 delta)</td><td>Collects the premium; your win line</td></tr>
            <tr><td><b>Long put</b></td><td style="color:var(--red)">BUY to open</td><td>One rung lower (e.g. <b>$90</b>)</td><td>Your stop-loss / max-loss floor</td></tr>
          </tbody>
        </table>
        </div>
        <p><b>Expiry (DTE):</b> 1–3 weeks for RSI2 (short hold), 2–4 weeks for Quality Dip. Both legs share the same expiry.</p>

        <h3 style="color:var(--text-mute);font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 6px">The numbers (formulas, fill in at the broker)</h3>
        <ul>
          <li><b>Net credit</b> = (premium from the $95 put you sold) − (premium for the $90 put you bought). You keep this if it expires worthless.</li>
          <li><b>Max profit</b> = the net credit (best case: stock stays above $95).</li>
          <li><b>Max loss</b> = (width between strikes) − credit = ($95 − $90) − credit = <b>$5 − credit per share</b> ($500 − credit per contract). This is your worst case, even if the stock craters.</li>
          <li><b>Breakeven</b> = short strike − credit = $95 − credit.</li>
          <li><b>Size:</b> 1 contract = 100 shares of exposure. Risk only what the max loss is per contract × number of contracts.</li>
        </ul>
        <div class="guide-pass" style="text-align:left">
          <b>Worked example (the put you buy is already netted in):</b>
          <pre style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px 10px;margin:8px 0;font-family:var(--font-mono);font-size:0.85rem;color:var(--text);white-space:pre-wrap">SELL $95 put  → RECEIVE +$2.00/sh  (+$200)
BUY  $90 put  → PAY     −$0.50/sh  ( −$50)   ← cost of the protective put
─────────────────────────────────────────
NET CREDIT    =         +$1.50/sh  (+$150)</pre>
          <ul style="margin:6px 0 0">
            <li><b>Max profit = the net credit = $150</b> — the $50 you spent on the $90 put is <i>already subtracted</i> here, so it's not an extra cost. Best case: stock above $95 → both puts expire worthless, you keep $150.</li>
            <li><b>Max loss</b> = width − net credit = ($95−$90) − $1.50 = <b>$3.50/sh ($350)</b>.</li>
            <li><b>Breakeven</b> = $95 − $1.50 = <b>$93.50</b>.</li>
          </ul>
        </div>
        <div class="guide-warn" style="text-align:left">
          <b>"Is $500 max loss too high vs. the profit?"</b> Two things:
          <ul style="margin:6px 0 0">
            <li>The <b>$500 is the gross width</b> ($95−$90 × 100), <b>not</b> the net loss. Subtract the credit: collect ~$150 → real max loss ≈ <b>$350</b> to make ~<b>$150</b>.</li>
            <li><b>You choose the width.</b> A <b>$95/$94</b> spread risks ~$100 gross instead of $500 (smaller credit too). Narrower = less risk and less reward.</li>
            <li><b>Yes, credit spreads risk more than they make per trade</b> — that's premium selling. The edge is the <b>high win rate</b> (~70%) plus <b>taking profit at ~50%</b> and <b>cutting losers early</b> (you rarely sit to full max loss). If risking-more-than-you-make bothers you, <b>buying a call</b> is the opposite shape: small defined cost, bigger upside, lower win rate.</li>
          </ul>
        </div>

        <h3 style="color:var(--text-mute);font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 6px">How to place it (one combined order)</h3>
        <ol>
          <li>In your broker, open the option chain for the ticker and pick the expiry (DTE above).</li>
          <li>Choose a <b>vertical / "bull put" spread</b> order (one ticket, not two separate orders).</li>
          <li><b>Sell to open</b> the <b>$95</b> put and <b>Buy to open</b> the <b>$90</b> put.</li>
          <li>Set it as a <b>net credit</b> limit order; submit at or near the mid price. Time-in-force GTC.</li>
        </ol>

        <h3 style="color:var(--text-mute);font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;margin:14px 0 6px">When to enter &amp; exit</h3>
        <ul>
          <li><b>Enter</b> on the bullish signal. Prefer <b>elevated IV</b> (you collect more premium); skip if IV is unusually low.</li>
          <li><b>Take profit</b> by closing the whole spread at ≈<b>50% of the credit</b> — don't be greedy holding to expiry for the last few cents.</li>
          <li><b>Cut it</b> if the stock breaks the signal's <b>SL</b> ($95) decisively — close the spread rather than risk assignment. (Your long $90 put already caps the loss, but closing early usually loses less than the max.)</li>
          <li>If it's near expiry and the stock is safely above $95, let it expire or close for a few cents.</li>
        </ul>
        <div class="guide-warn" style="text-align:left">
          <b>Needs spread-level options approval</b> (a higher tier than a plain cash-secured put). And remember: <b>this is the structure; the edge comes from the signal.</b> Trade it on the high-win-rate mean-reversion signals, not the losing strategies.
        </div>
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
