// =============================================================================
// trading.js — THE single place every TRADING knob is tuned.
//
// Two kinds of configuration exist in this system; keeping them apart is what
// makes either findable:
//
//   • src/config/env.js — DEPLOYMENT settings (credentials, DRY_RUN, which
//     universe to scan). Vary per machine. Set in swing.env.
//   • THIS FILE — TRADING behaviour (windows, cooldowns, deadlines, stop
//     overrides). Identical on every machine, versioned in git, because a change
//     here changes what gets traded and must be reviewable and revertable.
//   • Firestore /users/{uid}/automation/config — PER-USER risk limits
//     (riskPerTradePct, maxConcurrentPositions, tiers, indexes…). Changed from
//     the app UI, `npm run config`, or Telegram /set — no deploy needed.
//
// Strategy DEFINITIONS (entry rules, targets, stop distances, hold periods,
// tiering) are not here: they live with the strategies themselves in
// src/strategy/normalize.js — STRATEGY_TARGETS and STRATEGY_HOLD. They are the
// strategy, not a deployment knob. See docs/strategies.md.
// =============================================================================

// ---- Market session (US, ET minutes from midnight) --------------------------
export const MARKET_OPEN_ET_MIN  = 9 * 60 + 30;   // 09:30
export const MARKET_CLOSE_ET_MIN = 16 * 60;       // 16:00

// Morning entry window for the previous-session path (auto-trade.mjs), measured
// from the open. Wide (3.5 h) on purpose: GitHub Actions cron has been observed
// firing 2-3 hours late, and a narrow window would simply miss those days.
export const ENTRY_WINDOW_MINUTES = 210;

// Same-day "trade the close" window (same-day-trade.mjs). Ends before 15:50 ET,
// Alpaca's market-on-close cutoff — the last moment an order is still reliably a
// closing-price fill.
export const CLOSE_WINDOW_START_ET_MIN = 15 * 60 + 35;  // 15:35
export const CLOSE_WINDOW_END_ET_MIN   = 15 * 60 + 50;  // 15:50

// Hard per-order deadline. The window is checked once at startup, but scanning
// 1500 tickers takes ~6 minutes, so the clock is re-checked before EVERY order.
// Past this a market order no longer approximates the close, so the run stops
// rather than trading badly.
export const ORDER_DEADLINE_ET_MIN = 15 * 60 + 58;      // 15:58

// ---- Re-entry cooldown ------------------------------------------------------
// Days a ticker is untradeable after a LOSING exit.
//
// A mean-reversion setup keeps re-firing on a name that is still falling: the
// stop takes you out, the stock is now MORE oversold, so it qualifies again
// tomorrow. ARWR was entered and stopped out three times in three sessions
// (Jul 13/14/15) because nothing remembered the previous loss — that is one
// losing trade taken three times, not three independent edges.
//
// Winners never cool down: a name that sets up again after a win is the strategy
// working as intended.
//
// 0 disables. Default 3 ≈ half rsi2's 7-bar hold — long enough that a
// stopped-out name must actually base, short enough not to miss the next setup.
export const REENTRY_COOLDOWN_DAYS = 3;

// ---- Placed-stop override ---------------------------------------------------
// Overrides ONLY the stop sent to the broker, per strategy — not the quality
// filter that decides which signals are tradeable, nor the geometry the target
// is derived from. Empty means every strategy keeps its natural ATR stop.
//
// Deliberately EMPTY. A first backtest suggested widening rsi2 to 5%, but that
// comparison let each variant use its own closed-trade set, which flattered the
// wide stops. Do not add an entry here without a bias-free backtest supporting
// it — select on signal AGE, not on whether a trade closed:
//   node scripts/backtest-stop.mjs --strategy=<key> --stops=natural,3,5,8,none
// and read the MATURE SIGNALS table.
export const PLACED_STOP_PCT = {};
