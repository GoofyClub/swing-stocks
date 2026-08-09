# Strategy reference

Every strategy detects a setup, then a **normalizer** converts it into a uniform
trade envelope `{ entry, tp, sl }` so the rest of the system can treat them
identically. Detection lives in `src/strategy/engine.js`; the envelope
conventions live in `src/strategy/normalize.js`.

## Where each parameter lives

| Parameter | File | Change requires |
|---|---|---|
| Entry conditions | `src/strategy/engine.js` | code change |
| Target %, R clamps, stop bounds | `STRATEGY_TARGETS` in `normalize.js` | code change |
| Hold period (time stop) | `STRATEGY_HOLD` in `normalize.js` | code change |
| Tier rules | `tierReasons()` in `normalize.js` | code change |
| Execution windows, cooldown | `src/config/trading.js` | code change |
| Which strategies you trade, risk limits | Firestore automation config | UI / `npm run config` / `/set` |

## The parameter table

| Key | Name | Target % | R range | Stop % range | Hold (bars) | Basis |
|---|---|---|---|---|---|---|
| `pullback` | Pullback | 5% | 1.5–3.5 | 0.7–5% | 15 | 20-EMA pullback continuation, 42-48% WR, 2:1 R:R |
| `quality_dip` | QualityDip | 10% | 1.5–4.0 | 0.8–8% | 30 | Mean-reversion on quality, 60-70% WR, +5-15% |
| `vcp` | VCP | 18% | 2.0–8.0 | 1.0–7% | 25 | Minervini VCP, 55-68% WR, +10-30% |
| `rsi2` | RSI2 | 2% | 0.7–1.5 | 0.5–3% | 7 | Connors RSI(2), 75-85% WR claimed, +1-3% bounce |
| `pocket_pivot` | PocketPivot | 8% | 1.5–3.5 | 0.7–5% | 15 | Kacher/Morales, 55-65% WR, +5-15% |
| `htf` | HTF | 100% | 3.0–12.0 | 2.0–30% | 40 | O'Neil High Tight Flag, 65-75% WR, +50-300% |
| `nr7` | NR7 | 4% | 1.2–3.0 | 0.5–3% | 7 | Crabel NR7, 55-65% WR, +3-8% vol expansion |
| `fifty_two_wh` | 52WH | 10% | 1.5–4.0 | 0.8–6% | 30 | Jegadeesh/Titman, 60-65% WR, +5-15% drift |
| `peg` | PEG | 12% | 2.0–5.0 | 1.0–6% | 20 | Minervini/Zanger, 65-72% WR, +5-20% |
| `pead` | PEAD | 12% | 2.0–5.0 | 1.0–8% | 60 | Ball/Brown, 75-80% WR, +5-20% over 60d |
| `insider` | Insider | 15% | 2.0–6.0 | 1.5–10% | 60 | Lakonishok/Lee cluster, 65-75% WR |
| `analyst` | Analyst | 10% | 1.5–4.0 | 1.0–8% | 45 | Womack upgrade, 60-70% WR, +5-15% |
| `fvg` | FVG | 15% | 1.5–6.0 | 1.5–12% | 60 | Monthly bullish FVG retest in uptrend |

> **The "Basis" column is the published claim from the source literature, not a
> measured result from this system.** They are the calibration rationale for the
> target, nothing more. See "Measured vs claimed" below — for RSI2 the measured
> figure is materially lower.

## How the envelope is derived

`applyTarget()` turns a raw `{entry, sl}` into the traded envelope:

1. **Stop bounds gate the signal.** If `slPct` is outside `[minSlPct, maxSlPct]`
   the signal is **rejected entirely**. Too tight and normal noise stops you out;
   too wide and the strategy's typical move can't produce a workable R.
2. **Target = `entry × (1 + targetPct/100)`.**
3. **R clamp.** If the implied R falls outside `[minR, maxR]`, the target is
   moved to the nearest bound. This is why widening a stop also inflates the
   target — an 8% stop on RSI2 pushes its +2% target to +5.6%, which is no
   longer the same strategy.

## Exits, in priority order

`settleSignal()` walks each post-entry bar and takes the first that applies:

1. **TP** — bar high ≥ target.
2. **SL** — bar low ≤ stop. When both are touched on the same bar the outcome is
   booked as a **loss** (daily bars can't show which came first; pessimism is the
   honest default).
3. **Native exit** — RSI2 only: close back above the 5-day SMA. This is
   Connors' actual exit rule; the bounce is usually captured well before a fixed
   target.
4. **Time stop** — exit at the close of the hold-period bar.

Trend strategies (`pullback`, `vcp`, `peg`, `pocket_pivot`, `htf`, `nr7`,
`fifty_two_wh` — the `TRAILING_STRATEGIES` set) use a **trailing stop** instead
of a fixed target: breakeven at +1R, then trailing 2R below the running high.

### What the broker holds vs what the model does

The broker's resting legs can only express a fixed target and a fixed stop, so
the two are deliberately not the same thing:

| Strategy family | Order sent | Managed by the exit pass |
|---|---|---|
| Target-managed (`rsi2`, `quality_dip`, `fvg`, the FMP drifts) | bracket: TP **and** SL | native exit, time stop |
| Trailing (`TRAILING_STRATEGIES`) | OTO: **SL only** | trailing stop, time stop |

Trend entries carry **no take-profit leg**. They used to, and that was a defect:
`settleTrailing()` has no fixed target — it rides the position until the trailing
or time stop — so a take-profit at `signal.tpPrice` capped exactly the outsized
winners the model depends on to pay for its losers. Live results could only
underperform the backtest, in the one direction that matters. The order builder
now reads the same `usesTrailingExit()` predicate the settlement model does, so a
strategy cannot be modelled one way and traded another.

Because Alpaca rejects `order_class: bracket` unless *both* legs are present,
stop-only entries go out as `oto`. The adapter picks the class from the legs
actually attached.

Native, time-stop and trailing exits are applied by the exit-management pass
(`scripts/lib/exit-pass.mjs`), which replays the same settlement logic against
real fills. **Both** runners call it — the morning worker and the same-day
runner — because for a trend position it is the only managed exit that exists
besides the hard stop.

## Tiers

`tierReasons()` collapses each strategy's confluence flags into one bucket:

- **A+** — multiple top-shelf factors present
- **Tier 1** — fires cleanly
- **Tier 2** — fires with caveats

RSI2 specifically: **A+** needs RSI(2) < 5 *and* a 3-day decline streak; anything
else that fires is **Tier 1**. It never produces `null` — if you see `tier null`
in a log, that is a bug, not a filter.

## Measured vs claimed — read this before sizing up

`scripts/backtest-stop.mjs` re-settles real recorded signals. For **RSI2** over
180 days (135 mature signals, every variant fully resolved):

| Stop | WR | Net R | PF | Worst |
|---|---|---|---|---|
| natural (0.5–3%) | 53.3% | +12.34R | 1.13 | −2.97% |
| 5% | 73.3% | +5.51R | 1.20 | −5.00% |
| none | 75.6% | — | 0.97 | −30.43% |

Three things to take from this:

1. **The claimed 75-85% win rate is reachable only by removing the stop — and
   that configuration loses money** (PF 0.97). Wins are +1.68%, losses −5.35%.
   High win rate is not the objective.
2. **The best measured configuration is the current one**, at +0.09R per trade.
   With outcomes clustered near ±1R the standard error is ≈ 1.0/√135 ≈ 0.086, so
   t ≈ 1.0 — **statistically indistinguishable from zero**.
3. **Costs are not modelled.** 63 stop-outs in the sample; slippage of 0.1% per
   stop consumes ~6 of the 14.42 percentage points.

**Conclusion: RSI2 as configured is around breakeven and plausibly negative after
costs.** Treat paper trading as the real experiment, not a formality.

Re-run the measurement yourself:

```bash
npm run backtest:stop -- --strategy=rsi2 --days=400 --cache
```

Read the **MATURE SIGNALS** table. The other two are biased in opposite
directions — both condition on whether a trade closed, which is itself an outcome
of the stop being tested. Mature selects on signal *age*, which is not.

## Adding or changing a strategy

1. Detection in `src/strategy/engine.js`, returning a raw result object.
2. A normalizer in `normalize.js` that extracts `{entry, sl}` and calls
   `applyTarget()`.
3. An entry in `STRATEGY_TARGETS` (target, R clamps, stop bounds) and
   `STRATEGY_HOLD` (time stop).
4. A `tierReasons()` case.
5. If the entry is a buy-stop above the signal bar, add it to
   `STOP_ENTRY_STRATEGIES` — otherwise a name that rolls over is booked as a loss
   for a trade that never filled. **Buy-stop strategies are excluded from the
   same-day runner**, since the trigger can't resolve in the final minutes.
6. **Backtest before enabling it live.**
