# Changelog

## v0.13.0 — 2026-06-17 (live-quote slippage, market-hours guard, Alpaca smoke-test)

### Added
- **Live-quote slippage check** — the worker fetches a live trade price from the
  Alpaca data API for the pre-trade slippage guard instead of the cron's last
  close (falls back to the close if the data API is unavailable).
- **Market-hours guard** — won't place orders when the market is closed; dry-run
  continues so you can test any time. Adds `getClock()` + `getLatestPrice()` to
  the Alpaca adapter.
- **Alpaca smoke-test** (`scripts/alpaca-smoketest.mjs`, `npm run auto:smoketest`)
  — read-only validation of account/clock/positions/latest-price against a real
  (paper) account; places no orders.

### Changed
- **PDT note updated** — the US Pattern Day Trader rule ($25k minimum / 3-day-
  trades-per-5-days) has been removed; day-trade frequency is no longer capped by
  account size. Updated in the Automation guide and README.

## v0.12.0 — 2026-06-17 (sizing modes for small capital)

### Added
- **Fixed $ per trade** sizing mode — spend a set dollar amount per signal
  instead of risk-% of equity. Best for small accounts that want a known, small
  spend per name.
- **Max $ per position** — hard cap on the dollars in any single position, in
  both sizing modes (0 = no cap).
- **Buying-power awareness** in the worker — skips any trade whose notional
  exceeds remaining buying power, and reserves capital across a run.
- 7 new sizing unit tests (47 total in `tests/auto.mjs`).

### Notes
- Whole shares only (Alpaca bracket orders don't permit fractional shares), so a
  fixed budget below one share's price skips the trade — pair Fixed $ with a low
  Max price so signals are affordable. Back-compatible: default mode stays Risk %.

## v0.11.0 — 2026-06-17 (automation Phase 3: regime gate, kill switch, Auto Orders + README)

### Added
- **Market-regime gate** — the worker reads the latest `/marketData/{date}/regime/
  {market}` snapshot and blocks new long entries when it says go-to-cash (risk-off).
  Fails open if no snapshot exists. New "Respect market regime" toggle on the
  Automation settings page (`respectRegime`, default on).
- **Global kill switch** — abort all automation via the Auto-trade Action input
  `kill_switch=true` / env `KILL_SWITCH`, or persistently via Firestore
  `publicConfig/automation.paused = true` (checked every run).
- **Auto Orders page** (`/auto-orders`) — read-only view of the worker's journal
  (`/users/{uid}/autoOrders`): dry-run intents and real orders with status.
- **README.md** — operational reference: quick-command table, app/rules/index
  deploy steps, both workers' flags (DRY_RUN, only_uid, kill_switch), automation
  enablement, data model, and project layout.
- 4 more engine unit tests for the regime gate (40 total in `tests/auto.mjs`).

## v0.10.0 — 2026-06-17 (automation Phase 2: paper-execution worker + Live Signals R:R)

### Added
- **Auto-trade worker** (`scripts/auto-trade.mjs`, `Auto-trade (paper)` Action) —
  for each user with automation enabled, reads today's signals, applies their
  rules + portfolio guardrails, sizes by fixed-fractional risk, and submits
  **bracket orders** (entry + stop + target) via Alpaca. Idempotent (deterministic
  client order id), with an order journal (`/users/{uid}/autoOrders/{id}`) and a
  reconciliation pass.
  - **Safe by default:** `DRY_RUN=true` (logs intended orders without submitting);
    Alpaca **paper** endpoint forced unless `mode='live'`; manual `workflow_dispatch`
    only (no unattended schedule yet).
  - Guardrails live in the worker: max concurrent positions, per-sector cap,
    portfolio-heat cap, daily-loss halt, slippage budget, trade-day gate, price
    band, liquidity floor, and ticker exclusion list.
- **Pure engine** (`src/auto/engine.js`) — sizing, rule-matching, guardrails,
  idempotency, slippage, bracket-intent — covered by **36 unit tests**
  (`tests/auto.mjs`, now part of `npm test`).
- **Alpaca adapter** (`src/broker/alpaca.js`) — account, positions, bracket order
  submit, order lookup/reconcile; no SDK dependency.
- **Planned R:R column** added to **Live Signals** (matches Signal History).
- Owner-read Firestore rule for the `autoOrders` journal (requires a rules deploy).

### Notes
- Requires a Firestore rules deploy for the new `autoOrders` rule.
- Set repo secrets `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_JSON` (already
  used by the refresh cron). Each user's broker keys come from their own config.

## v0.9.1 — 2026-06-17 (outcome R per trade + NET R totals)

### Why
The R:R column showed *planned* reward-to-risk (set at signal time), which looked
contradictory next to the result — a loss could show 1.50:1 and a win 0.92:1.
Planned R:R is the setup geometry, not the outcome.

### Added
- **Outcome R column** (`OUT R`) on each Signal History row — the realized R once
  closed (return ÷ risk: a TP-hit on a 2:1 setup ≈ +2R, an SL-hit ≈ −1R). Empty
  while the trade is open, so it only shows a number once there's a real result.
  The existing R:R column now explicitly means *planned* reward-to-risk.
- **NET R column** in the strategy summary — total profit/loss in R across each
  strategy's closed trades — plus an **ALL totals row** (net R, avg R, win rate,
  PF, total %Δ) so you can read the bottom line of every listed trade at a glance.
- Outcome R added to the CSV export (`plannedRR` + `outcomeR` columns).

## v0.9.0 — 2026-06-17 (automation config + guide, Phase 1)

### Added
- **Automation settings page** (`/automation`) — config-only rules for auto-trading
  signals: master enable + paper/live mode, broker connection (broker, REST API
  base, API key/secret), signal selection (markets, tiers, sides, strategy
  allow-list), trade days, universe filters (price band, 20d $ADV floor, ticker
  exclusion list), and risk/sizing (risk per trade, max positions, per-sector cap,
  portfolio heat, daily-loss halt, slippage budget). Persists to
  `/users/{uid}/automation/config`.
- **Automation guide page** (`/automation-guide`) — how it works, full settings
  reference, risk management, pro practices, broker setup (Alpaca / India + SEBI
  note), safety/paper-first, legal/compliance, glossary, and an enhancement log
  to keep updated.
- New **Automation** sidebar group.

### Notes
- **Config-only:** the server-side execution worker that places broker orders is
  not yet deployed. Settings are saved but no orders are sent. `enabled` defaults
  off, `mode` defaults to paper.
- **Requires a Firestore rules deploy** (`firebase deploy --only firestore:rules`)
  so the new `/users/{uid}/automation/{doc}` owner-only rule takes effect; without
  it, saving the config is denied.

## v0.8.0 — 2026-06-17 (client-side realized %, R:R column, column customization, saved filters)

### Why
A strategy summary showed winners with a realized % *above* their TP cap (e.g. an
NR7 win at +3.71% when the TP only allowed +3.39%). Root cause: closed trades whose
docs were settled under the old model still carried a live-price `pctChange`, and
the v3 re-settlement cron hadn't re-graded them yet. The numbers looked
over-profitable.

### Fixed
- **Realized % computed client-side from `hitPrice`.** Signal History now derives a
  closed trade's return from the stored exit price (`hitPrice`) directly, so it's
  frozen at the TP/SL/native exit regardless of whether the settlement cron has
  re-graded the row. Winners no longer exceed their TP cap; losers no longer drift
  past their SL. Summary PF / AVG R / AVG %Δ / TOTAL %Δ all use this value.
- **Sector shows its name** ("Technology") instead of the raw ETF tag ("XLK"), in
  both Signal History and Live Signals. New `SECTOR_NAMES` / `sectorName()` map
  covers US SPDR sectors and the NSE sector indices.

### Added
- **R:R column** (planned reward-to-risk) on each Signal History row and a per-
  strategy **R:R** column in the summary.
- **CLOSED filter** in the Signal History W/L filter row (was open/win/loss only).
- **Customizable columns** — a ⚙ COLUMNS dialog to reorder (▲▼) and show/hide
  Signal History columns, persisted per browser. Default order is now
  date, name, ticker, strategy, status, %Δ, entry, TP, SL, then the rest.
- **Save filters** — a ★ SAVE FILTERS button stores the full filter set + timeframe
  to localStorage and restores it on the next visit (URL deep-links still win).

## v0.7.0 — 2026-06-16 (realized-return fix, R/profit-factor metrics, longer history)

### Why
The History strategy summary reported a 50% win rate alongside a near-zero total
return — a contradiction. Two bugs: closed signals' `pctChange` tracked the *latest
close* instead of the exit price (a settled −50% SL loss on a stock that later fell
to −75% was booked as −75%), and the per-strategy average diluted realized results
by dividing across *open* trades too.

### Fixed
- **Closed-signal returns frozen at exit.** `resettleRecentSignals` now derives a
  closed signal's `pctChange` from `verdict.hitPrice` (the tp/sl/native/time-stop
  level it left at), not the most recent close — matching how My Trades already
  computed `realizedPct`. `SETTLEMENT_VERSION` → 3 re-grades every retained closed
  signal once so historical numbers self-correct on the next cron run.
- **AVG %Δ is closed-only.** The strategy summary's average now sums realized
  `pctChange` across closed trades only and divides by the closed count, so open
  positions' paper marks no longer wash out the average.

### Added
- **AVG R and Profit Factor columns** in the strategy summary. AVG R normalizes each
  trade by its own risk (`pctChange / slPct`; a TP-hit ≈ +2R, an SL-hit ≈ −1R);
  Profit Factor is gross wins ÷ gross losses (>1 net-profitable, ∞ = wins, no losses).
- **TOTAL %Δ column** alongside AVG %Δ — sum of realized %Δ across closed trades.
- **Longer History timeframes.** Added 6M / 1Y / 2Y / All chips (default stays 90D).
  Load cap raised 500 → 3000 and signal retention 90 → 800 days so 1Y+ history can
  accrue. *Retention only affects data captured from here forward; already-pruned
  buckets are gone.*

## v0.6.0 — 2026-06-09 (settlement realism, A+ reasons, FVG strategy)

### Why
Reported win-rates sat far below each strategy's documented figures. Root cause:
settlement modelled a fixed TP/SL bracket held *indefinitely*, while the
documented win-rates come from each strategy's *native exit* within a *bounded
hold* (e.g. RSI(2) exits on the first close back above the 5-SMA, not a +R
target). Two correctness gaps compounded it.

### Changed
- **Entry-trigger aware settlement.** Buy-stop strategies (Pullback, NR7, VCP,
  HTF) no longer count a W/L until price actually triggers the entry. A name that
  rolls straight to the stop without filling stays OPEN, not LOSS — removing
  phantom losses that depressed win-rate.
- **Native exits + per-strategy time stop** in `settleSignal()`. RSI(2) settles on
  its documented close>5-SMA exit; every strategy now has a max-hold time stop
  (exit at the bar's close). Each closed signal records an `exitReason`
  (`tp`/`sl`/`native`/`time_stop`), surfaced on the W/L badge and CSV. Settlement
  remains deterministic — a decided verdict never changes as bars accrue.

### Added
- **Monthly FVG Retest (Bullish) strategy** (`fvg`). Wires the existing
  `evaluateFVGRetest()` into the tradeable registry: a stock in a monthly uptrend
  that corrected into a monthly bullish Fair Value Gap and is reversing off it.
  A+ on a full-zone reclaim.
- **A+ "why" reasons.** `tierReasons()` exposes the confluence factors that earned
  a tier; shown as a hover tooltip on tier badges (Live Signals + History),
  persisted by the cron, and added to the History CSV.
- `tests/settle.mjs` — settlement + tiering suite (54 assertions); `npm test`
  now runs engine-parity + settlement.

## v0.2.0 — 2026-05-18 (initial cloud-backed release)

### Why
The legacy single-file console (`swing_terminal_4-1.html`) had no persistence,
no auth, no history, and a UI that didn't scale to multiple devices. This
release re-platforms the app onto Firebase + GitHub Pages while preserving every
line of strategy math.

### Added
- **Vite-based SPA** under `/swing-stocks/` subpath with `404.html` SPA fallback for deep links.
- **Firebase Auth (Google)** with popup-on-desktop / redirect-on-mobile heuristic and `ensureUserDoc()` bootstrap.
- **Firestore with offline persistence** (`persistentLocalCache` + multi-tab manager).
- **Two-layer Firestore schema**:
  - `/marketData/{date}/signals/{id}` — shared, read-only for clients, written exclusively by the GitHub Actions cron via Admin SDK.
  - `/users/{uid}/{enteredTrades,watchlist,preferences}` — private per-user.
- **`firestore.rules`** enforcing the access model.
- **`firestore.indexes.json`** for the cross-bucket signal queries used by the History view.
- **GitHub Actions workflows**:
  - `deploy.yml` — builds Vite, copies `legacy/` alongside the bundle, publishes to GitHub Pages.
  - `refresh-signals.yml` — cron worker; runs `scripts/refresh-signals.mjs` on the Mon–Fri intraday schedule plus daily NSE EOD pass.
- **`scripts/refresh-signals.mjs`** — Admin-SDK signal generator. Runs every strategy across both markets, writes signals with explicit `entry/tp/sl`, re-settles open signals against fresh bars, prunes buckets older than 90 days.
- **Per-strategy signal normalizer** (`src/strategy/normalize.js`) that maps each engine output to `{ entry, tp, sl }` without modifying the strategy code itself. Includes `settleSignal()` for explicit TP-touched-since-signal-day = WIN / SL-touched = LOSS attribution.
- **New views**: Login, Dashboard (KPI tiles + today's signals + open trades), Signal History (3-month rolling, filterable, CSV export), My Trades (per-user, 30-day aggregate), Watchlist, Settings (Data Source collapsed by default).
- **Engine parity self-test** (`tests/engine-parity.mjs`) — 32 assertions on indicator primitives, strategy evaluators, and Stooq parsing. Runs in ~1s.

### Preserved (no changes)
- All strategy logic — every `evaluate*` function in `src/strategy/engine.js` is a byte-for-byte copy of the legacy block (lines 1356–2992 of `legacy/swing_terminal_4-1.html`). The only thing moved out is `fetchFMPData`, because it touched I/O state and now lives in `src/data/fmp.js` parameterised by API key + cache.
- All data-source fetchers (Alpha Vantage, Finnhub, Yahoo v7/v8, Stooq + 3 proxies). Refactored from `state.*` lookups to an injected `ctx` so they work in both browser and Node.
- All watchlists (US 53 stocks across XLK/XLC/XLY/XLV/XLF/XLI/XLE/XLP, India NIFTY 50 across 8 NSE sector indices), market configs, and sector ETF lists.
- The legacy console itself — copied to `legacy/swing_terminal_4-1.html` and reachable in production at `/swing-stocks/legacy/swing_terminal_4-1.html`.

### Configuration
- Win/Loss is now per-signal, not user-configurable. Each signal stores explicit `tpPrice` and `slPrice`; WIN = price.high ≥ tp on any day after signal date, LOSS = price.low ≤ sl on any day after signal date. Pessimistic tie-break (SL fills first if both touched on the same bar).
- Signal history retention: **3 months** (90 days). The cron deletes older `/marketData/{date}` buckets.
- Default theme: dark. Light theme via top-bar toggle, persisted to `localStorage`.
- Default market: US. Toggle in Settings.

### Monetization note
The current Firebase Spark (free) tier is sufficient for ~500 daily active users on the current data model (50 K reads/day cap). When that's hit, the upgrade story is: Blaze tier with a $0 budget alert (still free in practice), longer signal history (1y+), real-time intraday refresh, alerting via FCM, and strategy add-ons (paid-API-only strategies like PEAD/Insider/Analyst exposed to users). Auth/storage usage is uncapped on Spark, so the gating is purely on Firestore reads.
