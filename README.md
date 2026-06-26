# Swing Terminal (StockView)

Cloud-backed, multi-strategy swing-trading console. Static SPA (Vite) on GitHub
Pages + Firebase Auth/Firestore, with GitHub Actions workers for signal
generation and (paper) auto-trading.

- **Live app:** https://goofyclub.github.io/swing-stocks/
- **First-time Firebase setup:** see [`SETUP.md`](SETUP.md) (project creation,
  service account, API keys). This README is the **day-to-day operational
  reference** — the commands and flags you'd otherwise dig out of notes.
- **In-app automation docs:** the **Automation Guide** page (and
  [`src/views/automationGuide.js`](src/views/automationGuide.js)) holds the
  end-user explanation + a self-maintained enhancement log.

---

## Quick reference (most-used commands)

| Task | Command / action |
|---|---|
| Install deps | `npm ci` |
| Local dev server | `npm run dev` → http://localhost:5173 |
| Production build | `npm run build` |
| Run all tests | `npm test` (engine parity + settlement + auto engine) |
| Deploy the **app** | just `git push origin main` (GitHub Pages Action auto-runs) |
| Deploy **Firestore rules** | `firebase deploy --only firestore:rules` (manual, see below) |
| Deploy **Firestore indexes** | `firebase deploy --only firestore:indexes` |
| Run signal refresh now | GitHub → Actions → **Refresh shared signals** → Run workflow |
| Run auto-trade (dry-run) | GitHub → Actions → **Auto-trade (paper)** → Run workflow (`dry_run=true`) |
| Place real paper orders | same Action with `dry_run=false` |
| Validate broker adapter | `ALPACA_KEY=... ALPACA_SECRET=... npm run auto:smoketest` (read-only) |
| Kill all automation | Auto-trade Action with `kill_switch=true`, **or** set Firestore `publicConfig/automation.paused = true` |

> ⚠️ **Pushing to `main` deploys the app automatically. It does NOT deploy
> Firestore rules.** Whenever you edit `firestore.rules`, run the rules deploy
> command manually or the new rules won't take effect.

---

## Local development

```bash
npm ci                 # install
cp .env.example .env    # then fill in Firebase web config (see SETUP.md)
npm run dev            # Vite dev server
npm run build          # production build to dist/
npm test              # all test suites
```

Test suites individually: `npm run test:engine`, `npm run test:settle`,
`npm run test:auto`.

---

## Deployment

### App (automatic)
Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds with Vite
and publishes `dist/` to GitHub Pages. No manual step. Watch progress at
**GitHub → Actions → Deploy to GitHub Pages**.

### Firestore rules & indexes (manual)
The Pages deploy does **not** touch Firestore. After editing
[`firestore.rules`](firestore.rules) or `firestore.indexes.json`:

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

The Firebase CLI must be installed (`npm i -g firebase-tools`) and logged in
(`firebase login`). Rule changes that have required a manual deploy recently:
the per-user `automation/*` config and the read-only `autoOrders/*` journal.

---

## Workers (GitHub Actions)

Both workers run on `ubuntu-latest` and need these repo **Secrets**:
`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` (data-source keys
`ALPHAVANTAGE_KEY` / `FINNHUB_KEY` / `FMP_KEY` are optional — see `SETUP.md`).

> **Data reliability (important):** Yahoo and Stooq block datacenter IPs and
> AlphaVantage free is 25 calls/day, so on the GitHub runner the cron often
> **can't fetch bars** — which means signals **don't settle** (they stay "open"
> with a stale price). Fix: add repo secrets **`ALPACA_KEY`** + **`ALPACA_SECRET`**
> (your Alpaca key/secret — paper keys work for data). Alpaca Market Data is now
> the cron's first source and is reliable from CI. US equities only; India still
> falls back to Yahoo/Stooq.

### 1. Refresh shared signals — `.github/workflows/refresh-signals.yml`
Generates signals, settles open/closed trades, prunes old data.

- **Schedule:** every 30 min during US hours + an NSE EOD pass (UTC crons in the
  workflow).
- **Manual run:** Actions → *Refresh shared signals* → Run workflow (optional
  `markets` input, default `US,INDIA`).
- **Settlement version:** `SETTLEMENT_VERSION` in
  [`src/strategy/normalize.js`](src/strategy/normalize.js). Bump it when the
  settlement model changes so the next run re-grades already-closed signals once.
- **Retention:** `RETENTION_DAYS` in
  [`scripts/refresh-signals.mjs`](scripts/refresh-signals.mjs) (currently 800)
  governs how far back signals are kept and re-gradable. Extending it only
  affects data captured from then on — already-pruned buckets are gone.

### 2. Auto-trade (paper) — `.github/workflows/auto-trade.yml`
Places broker orders from matching signals for users who enabled automation.
**Runs on a daily schedule** (just after the US open + near the close) and on
demand. **Dry-run by default.** Script: [`scripts/auto-trade.mjs`](scripts/auto-trade.mjs).

- **Scheduled runs are dry-run** until you set the repo **variable**
  `AUTO_DRY_RUN = false` (Repo → Settings → Secrets and variables → Actions →
  **Variables**). A manual run can override via the `dry_run` input.
- Per-user `enabled` + `mode` still gate everything; Alpaca **paper** is forced
  unless a user set `mode='live'`.

Workflow inputs:

| Input | Default | Effect |
|---|---|---|
| `dry_run` | `true` | `true` = log intended orders, submit nothing. `false` = actually place orders. |
| `only_uid` | `''` | Restrict the run to one user uid (testing). |
| `kill_switch` | `false` | `true` = abort immediately, place nothing. |

Same flags exist as **env vars** when running locally:

```bash
# Simulate (default). Needs the Firebase service-account env vars set.
DRY_RUN=true  node scripts/auto-trade.mjs
# Real orders for a single user:
DRY_RUN=false ONLY_UID=<uid> node scripts/auto-trade.mjs
```

**Safety model:**
- `DRY_RUN` defaults to **true** everywhere — you must explicitly set it `false`.
- The Alpaca **paper** endpoint is forced unless a user set `mode='live'` in
  their config (a bad base URL can't route a paper run to live).
- **Idempotent:** a deterministic `client_order_id` (`at.<uid>.<signalId>`) means
  a re-run never double-submits the same user+signal.
- **Guardrails** (in [`src/auto/engine.js`](src/auto/engine.js), unit-tested in
  [`tests/auto.mjs`](tests/auto.mjs)): selection rules (market/tier/strategy/side/
  price band/liquidity/exclusion list), max concurrent positions, per-sector cap,
  portfolio-heat cap, daily-loss halt, slippage budget, trade-day gate, and the
  market-regime gate (blocks new longs when risk-off).

**Global kill switch (stop everything):**
- Per-run: Auto-trade Action with `kill_switch=true` (or `KILL_SWITCH=true` env).
- Persisted: set Firestore `publicConfig/automation` doc field `paused: true`
  (via the Firebase console). The worker checks this every run and aborts.

**Pre-trade checks (live):** the worker fetches a **live trade price** (Alpaca
data API) for the slippage guard instead of the cron's last close, and enforces a
**market-hours guard** — it won't place orders when the market is closed (dry-run
still runs so you can test any time).

**Validate the adapter first** with the read-only smoke-test (no orders placed):

```bash
ALPACA_KEY=... ALPACA_SECRET=... npm run auto:smoketest   # paper base by default
```

It checks account, clock, positions, and the latest-price endpoint against a real
account, confirming keys/base URLs/response shapes.

**Recommended rollout:** smoke-test → keep `dry_run=true` and inspect the Action
logs + in-app **Auto Orders** page → run one real paper order with
`only_uid=<your uid>` → go live (`mode='live'`) only after weeks of clean paper
results, tiny size.

> **PDT note:** the old US Pattern Day Trader rule (the $25k minimum / 3-day-trades-
> per-5-days cap) has been removed, so day-trade frequency is no longer limited by
> account size. Confirm your broker's current terms regardless.

---

## Automation: enabling it (per user)

1. Open the app → **Automation** page.
2. Connect a broker (Alpaca): paper base `https://paper-api.alpaca.markets`,
   live base `https://api.alpaca.markets`. Paste API key + secret (use a
   paper/trade-only key).
3. Pick markets, tiers, strategies, sides, trade days, price band, exclusion
   list, and risk/sizing.
4. Set **Mode = paper**, tick **Enable** when ready.
5. Run the Auto-trade Action (dry-run first). Review **Auto Orders**.

Config is stored at `users/{uid}/automation/config`; broker secrets live there
and are readable only by the owner (and the worker via the Admin SDK).

---

## Firestore data model

| Path | Written by | Read by |
|---|---|---|
| `marketData/{date}/signals/{id}` | refresh worker (Admin) | all signed-in users (incl. collection-group) |
| `marketData/{date}/regime/{market}` | refresh worker | dashboard + auto-trade worker |
| `users/{uid}/enteredTrades/{id}` | owner | owner |
| `users/{uid}/automation/config` | owner | owner + worker (Admin) |
| `users/{uid}/automation/state` | auto-trade worker (Admin) | owner (equity high-water mark) |
| `users/{uid}/autoOrders/{clientOrderId}` | auto-trade worker (Admin) | owner (read-only) |
| `users/{uid}/autoEquity/{date}` | auto-trade worker (Admin) | owner (equity curve) |
| `users/{uid}/fcmTokens/{token}` | owner | worker (Admin) |
| `users/{uid}/notifications/config` | owner | owner + workers (Admin) — Telegram creds |
| `cronRuns/{id}` | refresh worker (Admin) | any signed-in user — execution history |
| `publicConfig/automation` | operator (console) | auto-trade worker |

Access rules: [`firestore.rules`](firestore.rules).

---

## Project layout

```
src/
  strategy/      pure strategy engine + normalize/settlement (do not edit engine.js)
  auto/          auto-trade decision engine (pure, tested)
  broker/        broker adapters (alpaca.js)
  data/          firebase, fetchers, markets, trades, automation config
  ui/            sidebar, modal, column-prefs, signal-status
  views/         one module per route (dashboard, signals, history, automation, ...)
scripts/         refresh-signals.mjs (cron), auto-trade.mjs (execution worker)
tests/           engine-parity, settle, auto (run via npm test)
.github/workflows/  deploy.yml, refresh-signals.yml, auto-trade.yml
```

Version history: [`CHANGELOG.md`](CHANGELOG.md).
