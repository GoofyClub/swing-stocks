// Condor Desk Manual — HOW to operate the tool, button by button.
// (What the strategy is and why lives in the Condor Strategy Guide tab.)

export function renderCondorManual(root) {
  root.innerHTML = `
    <div class="view guide-view">
      <h1>Condor Desk Manual</h1>
      <p class="subtitle">How to use the <a href="#/condor-desk" style="color:var(--cyan)">Condor Desk</a>, step by step. For the strategy itself, read the <a href="#/condor-guide" style="color:var(--cyan)">Strategy Guide</a> first.</p>

      <section class="guide-section">
        <h2>One-time setup</h2>
        <ol>
          <li><b>Webull:</b> get <b>Level 3</b> options approval (spreads). Level 2 cannot open condors.</li>
          <li><b>Firestore rules</b> (repo owner, once): <code>firebase deploy --only firestore:rules</code> — until then presets/journal only persist in this browser (localStorage fallback).</li>
          <li><b>Alpaca keys (recommended):</b> add your Alpaca API key/secret in the <a href="#/automation" style="color:var(--cyan)">Automation</a> tab (paper-account keys are fine). This unlocks Alpaca's <b>real-time indicative options feed</b> for SPY — far more reliable in-browser than the CBOE fallback, which some networks/ad-blockers reject.</li>
          <li><b>Telegram (optional):</b> Settings → Telegram notifications → bot token + chat id → test. The Desk's SEND TO TELEGRAM button reuses this.</li>
          <li>Open the Desk once and click <b>SAVE AS ACTIVE</b> to store the defaults to your profile. <b>The defaults are the recommended setup</b> — the config panel stays collapsed because you don't need to change anything to start.</li>
        </ol>
      </section>

      <section class="guide-section">
        <h2>The routine (managed mode — under 5 minutes)</h2>
        <ol>
          <li>Open <b>Condor Desk</b> → click <b>GET TODAY'S LEGS</b>. The status line under the button shows the data source and the exact time it was fetched (ET) so you always know how fresh the numbers are; a repeat click the same trading day reuses that fetch instead of hitting CBOE/Alpaca again — click <b>↻ Refresh data</b> next to it if you want live quotes right now instead.</li>
          <li><b>Check the summary box's verdict first.</b> <b style="color:var(--green)">✅ GO</b> = every entry rule passed, proceed. <b style="color:var(--amber)">⏸ WAIT</b> = a blocking rule fired (thin credit, VIX floor, weekend/holiday preview, staggered-entry, wrong entry day, NFP-Friday expiry) — read the amber boxes below the summary for which one, and don't trade today.</li>
          <li>Amber boxes below the summary that <i>aren't</i> counted as blockers are cautions — e.g. a liquidity flag on one leg, or a high-VIX headline-regime note (size down, don't skip automatically; see the Strategy Guide §4). Read them before placing the order.</li>
          <li>GO (or an accepted caution) → read the four-leg table: <b>green rows = SELL to open, red rows = BUY to open</b>, exactly as you'll enter them.</li>
          <li>In Webull: Options → SPY → pick the <b>expiry shown on the card</b> → strategy <b>Iron Condor</b> (or 4-leg custom) → enter the four strikes → <b>net credit limit</b> starting at the card's mid credit. Patience beats speed: accept ≥ the floor the card prints, otherwise requote.</li>
          <li>Filled? <b>Immediately</b> place the GTC buy-back order at the TAKE PROFIT mark from the card. Set price alerts at the HARD STOP mark.</li>
          <li>Click <b>LOG THIS TRADE</b>. Optionally <b>SEND TO TELEGRAM</b> so the plan is on your phone.</li>
          <li>Daily until closed: one glance. GTC filled → journal it as TP HIT. Calendar reaches the TIME EXIT date → close and journal TIME EXIT. Stop mark trades → close everything, journal STOPPED.</li>
        </ol>
        <p class="muted">1-DTE mode differs only in cadence: compute Thursday after 10:00 AM ET for Friday's expiry, alerts at the two per-side stop marks, let it expire if untouched (XSP/SPX) or close by 3:30 PM ET (SPY).</p>
      </section>

      <section class="guide-section">
        <h2>Reading the trade card</h2>
        <ul>
          <li><b>Summary box</b> (top, cyan border): the one-glance version — today's date/price/VIX, the trade (expiry, DTE, est. POP), all four legs on one line, credit to collect, the profit plan, the loss plan, when to enter, and the <b>GO / WAIT verdict</b>. Built for a 10-second morning read; everything below it is the same information in full detail.</li>
          <li><b>Amber warning boxes:</b> each one is a specific rule firing — skip-rule (credit too thin), VIX floor (too low, or too high = headline regime), staggered-entry, weekend/holiday preview, liquidity flags, sizing, wrong entry day, NFP-Friday. Some block the GO verdict, some are cautions only — see the Strategy Guide §5 for which is which.</li>
          <li><b>Header chips:</b> spot · expiry (with DTE) · net credit <i>mid / natural</i> (mid = patient fill target; natural = instant-fill worst case) · credit as % of width (quality gauge) · est. POP · VIX · contracts.</li>
          <li><b>Legs table:</b> strike, bid/ask, mid, |delta| (shorts should sit in your band; wing delta doesn't matter), open interest — shown as "—" when the data source doesn't report it (e.g. Alpaca's snapshot feed).</li>
          <li><b>Profit zone line:</b> your breakevens and how much room spot has to each.</li>
          <li><b>Management tiles:</b> TAKE PROFIT mark (+$), TIME EXIT date, HARD STOP mark (−$), DEFINED RISK. These four numbers ARE your plan — the ticket repeats them in text.</li>
          <li><b>Defend note</b> (managed mode): the optional roll-the-untested-side move, for when a short strike's delta reaches ~0.30.</li>
          <li><b>Ticket box:</b> plain text of everything — COPY TICKET or SEND TO TELEGRAM.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Open Positions (the tracker)</h2>
        <p>Above the journal, every trade logged with status <b>OPEN</b> gets its own card showing where it stands right now — no mental math, no re-reading the ticket.</p>
        <ul>
          <li><b>Refresh behavior:</b> checked once automatically the first time you open the Desk each day, then cached — no repeat network calls until the next US-Eastern calendar day. Click <b>↻ Check all open positions</b> (top of the card) or a single card's <b>↻ Check status</b> to force a live update any time.</li>
          <li><b>The gauge</b> (managed mode): a single red→green bar from your <b>hard stop</b> to your <b>profit target</b>, with a pin showing the current mark and tick marks for entry credit and target. Pin on the green end = close to target; pin on the red end = close to the stop. The chip above names the state in words: <b>ON TRACK</b>, <b>WATCH</b> (a short strike is tested, or the mark has drifted within 20% of the stop), <b>TARGET HIT</b>, <b>STOP HIT</b>, or <b>TIME EXIT</b>.</li>
          <li><b>1-DTE mode</b> shows two independent gauges, one per side (call and put), since each side is stopped separately at 3× its own credit — a stop on one side never implies anything about the other, and the chip names exactly which side needs closing.</li>
          <li><b>Strike ruler:</b> spot's position relative to your four strikes and the profit zone between the breakevens — the same read as the tastytrade-style payoff ruler, at a glance.</li>
          <li><b>DTE strip</b> (managed mode only): a second, independent bar tracking calendar days toward the stored <b>time-exit date</b> — the 21-DTE rule fires on the calendar regardless of where the mark sits, so this is deliberately separate from the profit/loss gauge above it.</li>
          <li><b>Defend annotation:</b> appears when a short strike enters the ~0.30-delta defend zone, pointing back to the optional roll move in the Strategy Guide §6.</li>
          <li>Cards disappear once you set the trade's journal status to anything other than OPEN.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Configuration reference (every field is tweakable and saved)</h2>
        <p>Hover any field in the Desk for its tooltip. Summary:</p>
        <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Field</th><th>Default</th><th>Raise it when…</th><th>Lower it when…</th></tr></thead>
          <tbody>
            <tr><td>Underlying</td><td>SPY</td><td colspan="2">Switch to XSP/SPX for cash settlement + 60/40 tax as the account grows.</td></tr>
            <tr><td>Expiry mode</td><td>30–45 DTE</td><td colspan="2">Two complete rulebooks; both parameter sets are saved independently.</td></tr>
            <tr><td>Capital ($)</td><td>10,000</td><td colspan="2">Keep honest — every sizing number derives from it.</td></tr>
            <tr><td>Target DTE / min / max</td><td>40 / 30 / 45</td><td>You want slower decay, more premium</td><td>You want faster cycles (more gamma)</td></tr>
            <tr><td>Short delta band</td><td>0.12–0.18</td><td>More credit, lower win rate</td><td>Higher win rate, thinner credit</td></tr>
            <tr><td>Wing width (% of spot)</td><td>0.75 (≈$5 SPY)</td><td>Keep more credit per $ of width</td><td>Cap risk tighter per condor</td></tr>
            <tr><td>Min credit (% of width)</td><td>20</td><td>Demand better pay (skip more weeks)</td><td>Accept thinner premium (not advised)</td></tr>
            <tr><td>Profit target (% of credit)</td><td>50</td><td>Squeeze more per trade (more gamma exposure)</td><td>Exit even earlier, higher win rate</td></tr>
            <tr><td>Time exit (DTE)</td><td>21</td><td>Leave the danger zone earlier</td><td>(Not advised below ~14)</td></tr>
            <tr><td>Loss exit (× credit)</td><td>2</td><td>More breathing room, bigger losses</td><td>Tighter stop, more stop-outs</td></tr>
            <tr><td>Risk per trade (% capital)</td><td>5</td><td>(Blueprint caps at 5 — think hard)</td><td>Even safer sizing</td></tr>
            <tr><td>Min VIX to enter</td><td>13</td><td>Only sell rich premium</td><td>Trade in calmer regimes too</td></tr>
            <tr><td>High-VIX caution level</td><td>27</td><td>Only flag truly extreme regimes</td><td>Get warned earlier in a rising-vol market</td></tr>
            <tr><td colspan="4" class="muted">1-DTE mode fields: cadence (Thu→Fri / any-day / twice-weekly), delta band 0.06–0.12, wings 0.65%, per-side credit floor 0.025% of spot, per-side stop 3×, high-VIX caution level 25 (more sensitive than managed mode — less time to expiry to absorb a shock).</td></tr>
          </tbody>
        </table>
        </div>
        <ul>
          <li><b>SAVE AS ACTIVE</b> — persists the current form to your profile (used on next compute anywhere you sign in).</li>
          <li><b>Presets</b> — name + SAVE PRESET snapshots the whole config (both modes); LOAD restores it (then SAVE AS ACTIVE to keep); DELETE removes it. Use presets for experiments: e.g. "conservative-10Δ", "weekly-1dte".</li>
          <li><b>RESET MODE DEFAULTS</b> — restores the current mode's playbook numbers without touching the other mode.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Journal</h2>
        <ul>
          <li><b>LOG THIS TRADE</b> stores date, mode, legs, credits, and the <b>exit plan</b> exactly as computed at the time — this is what answers "when do I close this, and at what profit?" days or weeks later, without having to remember or recompute. It's the <b>Exit Plan</b> column in the table: managed mode shows <code>TP≤mark · by date · SL≥mark</code>; 1-DTE mode shows each side's stop mark.</li>
          <li>When a trade resolves: set the status (<b>TP HIT / EXPIRED WIN / TIME EXIT / STOPPED / CLOSED</b>), type the realized P&amp;L in dollars, click SAVE. The summary line recomputes win rate and total P&amp;L.</li>
          <li>Review every ~12 trades: if the win rate or average loss drifts far from the Strategy Guide's expectations, something in your execution (usually skipped exits) needs fixing before the config does.</li>
        </ul>
      </section>

      <section class="guide-section">
        <h2>Troubleshooting</h2>
        <ul>
          <li><b>"Could not compute legs" / "Failed to fetch":</b> the Desk tries three sources in order — Alpaca (needs keys in the Automation tab; SPY only), CBOE direct, CBOE via proxy. Persistent failures almost always mean: no Alpaca keys AND your network/ad-blocker rejects cdn.cboe.com. Fix: add Alpaca keys (best), or whitelist this site in your ad-blocker, or retry later.</li>
          <li><b>Numbers differ from Webull:</b> the status line under the button names the source. Alpaca is real-time (indicative); CBOE is ~15-min delayed. Strikes picked by delta barely move either way; always set your limit from the card but judge the fill against Webull's live mid — if far off, recompute.</li>
          <li><b>Presets/journal don't persist across devices, or LOG THIS TRADE says "✓ Logged (saved on this device only…)":</b> Firestore rules not deployed yet (see setup) — data is falling back to this browser's localStorage until you (repo owner) run <code>firebase deploy --only firestore:rules</code>. Locally-saved trades still show up in the Journal and Open Positions and can be edited/deleted normally.</li>
          <li><b>"Missing or insufficient permissions" appeared, then LOG THIS TRADE still worked:</b> that's expected — it's Firestore rejecting the cloud write (rules not deployed, see above), and the Desk automatically falls back to saving the trade on this device instead of losing it.</li>
          <li><b>Sizing warning says "over the sizing rule":</b> one condor's defined risk exceeds your risk % of capital. Either accept consciously, add capital, or use narrower wings.</li>
          <li><b>Everything shows a skip warning for weeks:</b> that's a calm market, not a bug. Not trading IS the strategy sometimes.</li>
          <li><b>Computed on a weekend and the verdict is WAIT with a "PREVIEW" note:</b> correct behavior — markets are closed, quotes are Friday's close. Use it to plan Monday's/Thursday's trade, then recompute on the actual trading day before placing anything.</li>
          <li><b>Verdict says WAIT but I don't see why:</b> the summary box only shows the verdict, not the reason — scroll to the amber warning boxes just below it; the specific rule that fired is spelled out there.</li>
          <li><b>Big news day (Fed, tariffs, geopolitics) and VIX is spiking:</b> the Desk will flag a high-VIX caution once it crosses your configured level (default 27 managed / 25 for 1-DTE) — read the Strategy Guide §4 for what's automatic (wider strikes, fatter credit) vs. what isn't (predicting the headline itself). The guidance is size down or stand aside, not "the tool has it covered."</li>
          <li><b>Status line says "(cached)" and I want a fresh quote:</b> click <b>↻ Refresh data</b> next to it — it bypasses the cache for that one compute. The cache is tied to the calendar date (US-Eastern) it was fetched on and is never reused once that date has passed, so you'll never see yesterday's — or last week's — chain silently.</li>
          <li><b>An open position's card says "NOT YET CHECKED":</b> the automatic check hasn't run yet (or failed silently, e.g. no network) — click <b>↻ Check all open positions</b> to force it.</li>
          <li><b>A position's card won't refresh / status looks stale:</b> position checks re-fetch the chain windowed around <i>that trade's own expiry</i>, not today's entry window — if the expiry has been delisted (e.g. very old 1-DTE trade you never closed), the check will keep failing; close it out manually in the journal.</li>
        </ul>
      </section>
    </div>
  `;
}
