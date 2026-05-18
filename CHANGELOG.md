# Changelog

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
