# US Weekly Iron Condor — Mechanical Rulebook

A US-market translation of Sharique Samsudheen's "1% Atishaktam" Nifty option-selling
strategy (weekly 1-DTE iron condor). Every rule below is mechanical — no judgment calls
required to execute the base system. Discretionary enhancements are separated at the end.

> **Note — this documents the 1-DTE weekly mode.** The Condor Desk tab's *default* mode
> is the classic **managed 30–45 DTE condor** (per the daystoexpiry.com entry/exit
> playbook): enter ~35–40 DTE, short strikes 0.15–0.20 delta, wings ~1.5% of spot,
> **close at 50% of max profit or at 21 DTE (whichever first), hard stop at 2× the
> credit received** — historically ~78–82% win rate when managed by those rules. It
> needs attention only once a day and is far more forgiving for beginners; the 1-DTE
> system below is the faster, stricter alternative. The Condor Guide tab compares the
> two modes side by side.

---

## 1. The source strategy in one paragraph

Sell a **1-day-to-expiry iron condor on the Nifty index** every Wednesday morning
(Thursday is Nifty's weekly expiry): sell an out-of-the-money call at a level the index
"won't reach by expiry" with a premium of about ₹8–10, buy a call 150 points further out
as protection, and mirror the same on the put side — collecting a **net credit of ~₹6 per
side**. Hold to expiry and let everything decay to zero. If either side's loss reaches
**3× that side's credit**, close that side and let the other run. Result: ~1% return on
deployed capital in winning weeks, ~1% loss in stopped weeks, with a high win rate —
an overall risk:reward of roughly 1:1 per week.

## 2. Instrument selection (the "which instrument" answer)

**Use S&P 500 index products. Do not use individual stocks.**

Successful systematic premium sellers (put-write funds, overlay funds, prop desks) sell
index options, not single-stock options, because:

- **Gap risk**: individual stocks — even "stable" ones — gap 5–15% overnight on earnings,
  guidance, FDA/legal news. A gap through your stop is this strategy's only serious loss
  mode. A 500-stock index diversifies single-name news away; the source strategy uses
  Nifty (an index) for exactly this reason.
- **Liquidity**: SPX/SPY option chains are the deepest in the world — penny-wide markets
  matter when a stop triggers and you must exit fast.
- **Structure**: index options (SPX/XSP) are cash-settled, European-style (no early
  assignment), taxed 60/40 under Section 1256, and have **daily expirations**, which the
  1-DTE cadence requires.
- Traders who do sell single-stock options successfully are running a different strategy
  (covered calls / cash-secured puts on stocks they want to own), not a defined-risk
  weekly income condor.

Pick by account size and broker:

| Instrument | Type | Settlement | Best for | Capital per condor | Notes |
|---|---|---|---|---|---|
| **XSP** (Mini-SPX, 1/10 SPX) | Index option | Cash, European, PM | Accounts ≥ ~$4k | ~$3.5–4k | Recommended starting point. Schwab / IBKR / Tastytrade / Fidelity. Not on Alpaca. |
| **SPX** (SPXW weeklys) | Index option | Cash, European, PM | Accounts ≥ ~$40k | ~$35–40k | Same as XSP × 10. Lowest fee drag per dollar. |
| **SPY** | ETF option | Physical, American | Alpaca accounts (no index options there) | ~$3.5–4k | Assignment risk → **must close all legs by 3:30 PM ET on expiry day, never let expire** (Rule 9b). |

All three have Monday–Friday expirations, so the weekly 1-DTE rhythm works on any of them.

## 3. Nifty → US scaling table

All strike/premium rules scale as a percentage of spot. Reference examples assume
SPX ≈ 6,800 / XSP ≈ 680 / SPY ≈ 680 — recompute from the formulas, not the examples.

| Parameter | Nifty original | % of spot | SPX | XSP / SPY |
|---|---|---|---|---|
| Short-strike premium target | ₹8–10 | ~0.04% | $2.40–3.00 | $0.24–0.30 |
| Wing distance (buy leg) | 150 pts | ~0.65% | 40–45 pts | 4–5 pts |
| Net credit per side | ~₹6 | ~0.027% | $1.75–2.00 | $0.17–0.20 |
| Max profit per condor (both sides) | ₹300 | — | ~$350–400 | ~$35–40 |
| Capital allocated per condor | ₹30,000 | — | $35–40k | $3.5–4k |
| Weekly target | 1% | — | 1% | 1% |

## 4. The Mechanical Rulebook

### Rule 1 — Schedule
- **Enter every Thursday between 10:00 and 10:30 AM ET**, selling the **Friday expiry
  (1 DTE)**. One cycle per week.
- Market must have been open ≥ 30 minutes before entry (mirrors the 9:30 IST + settle-down
  rule; US open is 9:30 ET).

### Rule 2 — Event filter (skip weeks)
Do **not** enter the Thursday→Friday cycle if any of the following falls between entry and
expiry:
- FOMC rate decision or Fed Chair press conference,
- CPI or NFP release (both print 8:30 AM ET; **NFP is always a Friday** — check every week),
- If the cycle is skipped, either stand aside for the week or run the identical rules
  Monday→Tuesday instead.

### Rule 3 — Short strike selection (call side)
1. On the 1-DTE chain, find the call whose **delta is 0.08–0.10** (equivalently premium
   ≈ 0.04% of spot: ~$2.40–3.00 SPX, ~$0.25 XSP/SPY).
2. Sanity check: the strike must be **at or beyond** the nearest obvious resistance
   (prior day high, recent supply zone, round number like 6,800). If it isn't, move **one
   strike further out** even if premium drops.
3. This is your **call sell leg**.

### Rule 4 — Short strike selection (put side)
Mirror of Rule 3: 0.08–0.10 delta put (premium ≈ 0.04% of spot), at or beyond the nearest
support / round number. This is your **put sell leg**.

### Rule 5 — Wings (buy legs)
- Buy the call **0.6–0.7% of spot further out** than the call sell leg
  (SPX: 40–45 pts; XSP/SPY: 4–5 pts). Same distance on the put side.
- Use the same width on both sides.

### Rule 6 — Credit acceptance test
- Net credit per side (sell premium − buy premium) must be **≥ 0.025% of spot**
  (SPX ≥ $1.70, XSP/SPY ≥ $0.17), and the two sides' credits should be roughly equal
  (within ~25% of each other).
- If you cannot collect this at 8–10 delta, **volatility is too low — skip the week.**
  Do not move strikes closer to force the credit.

### Rule 7 — Position sizing
- **1 condor per $35–40k of capital (SPX)** or **per $3.5–4k (XSP/SPY)**.
  `condors = floor(account_capital / allocation_per_condor)`
- This calibration makes the weekly win ≈ +1% of capital, a stopped week ≈ −1%, and a
  worst-case overnight gap (through the stop to max loss) ≈ −10% — the same risk profile
  as the original. Sizing bigger raises the weekly return *and* fattens the tail; don't.

### Rule 8 — Order execution
- Preferred: submit the whole condor as a **single 4-leg iron condor order** at mid-price;
  if unfilled in 60 seconds, step toward the market in 1-tick increments.
- If your broker requires legging in: **buy legs first, then sell legs** (per side).
  When exiting: **close short legs first, then long legs.**

### Rule 9 — Exits
**(a) Stop loss — per side, tracked separately:**
- Track each side's spread P&L (call spread and put spread independently).
- **Close a side entirely when that side's spread mark reaches 4× the credit collected
  on it** (i.e., the loss equals 3× that side's credit).
  Example: call spread sold for $1.80 → close the call side if it trades at $7.20.
- Set GTC limit orders or price alerts at the 4× mark immediately after entry.
  The stop is **not optional** — near the short strike, delta and gamma are high and 30–50
  points of slippage can erase a quarter's profits (the transcript is emphatic on this).
- The untouched side **stays on** to expiry.

**(b) Expiry:**
- **SPX / XSP**: if both short strikes are ≥ 0.3% away from spot at 3:30 PM ET Friday, do
  nothing — cash settlement takes care of it. If either short strike is within 0.3% of
  spot, close that side at market before 3:45 PM ET.
- **SPY**: always close **all remaining legs by 3:30 PM ET on expiry day**, at any price.
  Never carry SPY short options into settlement (assignment + pin risk).

### Rule 10 — Weekly bookkeeping
Log for every cycle: entry date, spot, 4 strikes, credits per side, stop level per side,
exit reason (expiry / SL / manual), P&L, and P&L as % of allocated capital. Review after
every 12 weeks; the system only compounds if the log shows the ~1% / −1% profile holding.

## 5. Worked example (SPX ≈ 6,800, Thursday 10:05 AM ET)

1. Call side: 6,900C (≈ 9-delta, ~1.5% OTM) bid ≈ $2.60 → sell. Buy 6,940C ≈ $0.80.
   **Call credit ≈ $1.80.**
2. Put side: 6,700P (≈ 9-delta, ~1.5% OTM) bid ≈ $2.70 → sell. Buy 6,660P ≈ $0.90.
   **Put credit ≈ $1.80.**
3. Total credit $3.60 → max profit **$360** on a ~$36k allocation ≈ **1.0%**.
4. Stops: close call side if the call spread trades ≥ $7.20; same for the put side.
5. Friday 3:30 PM ET: SPX at 6,812 — both shorts far OTM → let it cash-settle. +$360.

Stopped-week math: one side stops (−3 × $180 = −$540), other side expires (+$180)
→ week ≈ **−$360 ≈ −1%**. Overall R:R ≈ 1:1 with a high win rate — identical to the
source strategy's "mathematics beauty."

## 6. Optional discretion layer (NOT base rules)

The transcript is explicit that base rules alone produce modest returns; the 40–50%/yr
years came from discretionary adjustments layered on top. Add these only after ~3 months
of executing the base rules cleanly:

- **Roll the winner closer**: when a sold option decays to ≤ 20% of its credit before
  expiry, buy it back and re-sell a nearer strike (same expiry, same wing width) that
  meets the Rule 6 credit test.
- **Re-enter after a stop**: after a side stops out and the move stalls (e.g., market
  consolidates at a support/resistance), sell a fresh spread on that side further out —
  this is how a −1% week becomes −0.5%, breakeven, or even positive.
- **Early profit-take**: risk-averse variant — close everything when ~80% of the total
  credit is captured, accepting ~0.8%/week instead of 1%.

## 7. Risk & expectations (read before trading)

- **Gap risk is real and accepted.** A large overnight gap opens beyond your stop and you
  will lose more than 3× credit — occasionally 5–10% of capital in a day (the author lost
  5% on the Russia–Ukraine open and still finished the year +40%). The defense is Rule 7
  sizing and the Rule 2 event filter, not hope.
- **Realistic returns**: base rules ≈ 25–40%/yr *before* costs, with losing weeks roughly
  every few weeks. Anyone expecting more from the base rules should re-read Section 6.
- **Fee drag scales inversely with size** (the ₹30k vs ₹3L point translated): a 4-leg
  XSP/SPY condor costs roughly $1–3 round trip in commissions/fees against ~$36 max
  profit (~5–8% drag); SPX costs ~$5–10 against ~$360 (~2%). Small accounts learn on
  XSP/SPY; the economics genuinely improve with SPX-scale capital. (Alpaca charges no
  commission on SPY options — regulatory fees only.)
- **Taxes**: SPX/XSP gains are Section 1256 (60% long-term / 40% short-term) regardless of
  holding period; SPY options are ordinary short-term. This alone can be worth ~10% of
  the annual return to a US taxpayer — one more reason index options win.
- This document is a trading-rules reference, not financial advice. Paper-trade at least
  4 full weekly cycles before deploying capital.
