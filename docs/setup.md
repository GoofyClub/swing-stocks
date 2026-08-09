# Setting up from scratch

Start-to-finish for a new deployment. Roughly 45 minutes, most of it waiting on
Google Cloud.

Read [going-live.md](going-live.md) before pointing any of this at real money —
this guide gets you to a working **paper** system, which is where you should stay
for weeks.

## What you are building

| Piece | Runs where | Schedule | Purpose |
|---|---|---|---|
| Web app | GitHub Pages | on push to `main` | signals, history, config UI |
| `refresh-signals` | GitHub Actions | cron, several/day | scans the universe, writes signals, settles outcomes |
| `same-day-trade` | **your VM** | systemd timer, 15:38 ET | scans and enters at the close ← the trading path |
| `maintenance` | **your VM** | systemd timer, 09:45 + 16:15 ET | reconcile, exits, realized P&L, equity/drawdown |
| `telegram-bot` | **your VM** | always on | monitor and control from a phone |
| `dashboard` | **your VM** | always on | the log, over HTTP |

**The VM owns trading; Actions owns signals.** Nothing that touches an order runs
on a timer in Actions — its cron runs 2–3 hours late on this repo, gets
cancelled, and sometimes fails to allocate a runner at all. Survivable for a
signal refresh, not for reconciliation or exit management. See
[architecture.md](architecture.md) for what breaks when each piece is missed.

## Prerequisites

- A **Firebase project** with Firestore enabled
- An **Alpaca paper account** (keys used for both trading and market data)
- A **GCE VM** (Debian/Ubuntu, e2-micro is plenty)
- Optionally a **Telegram bot** from [@BotFather](https://t.me/BotFather)

---

## 1. Firebase

1. Create the project, enable **Firestore** and **Authentication** (Google
   sign-in).
2. Deploy the security rules and indexes — the app will not work without them:
   ```bash
   npx firebase-tools deploy --only firestore:rules,firestore:indexes
   ```
3. **Strongly consider the Blaze plan.** The free tier's 50k daily reads has
   repeatedly been exhausted here and takes the trading worker down with it
   (`RESOURCE_EXHAUSTED`). At this volume Blaze is typically cents per day, and
   it removes an entire class of outage.

## 2. Web app (GitHub Pages)

Add these repo **Secrets** (Settings → Secrets → Actions):

```
VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID,
VITE_FIREBASE_STORAGE_BUCKET, VITE_FIREBASE_MESSAGING_SENDER_ID,
VITE_FIREBASE_APP_ID, VITE_FIREBASE_VAPID_KEY
```

Push to `main` and the deploy workflow publishes the site. Sign in once — that
creates your user document.

## 3. GitHub Actions workers

Same Secrets page:

```
FIREBASE_PROJECT_ID              your project id
FIREBASE_SERVICE_ACCOUNT_JSON    service-account key JSON (CI only; the VM uses ADC)
ALPACA_KEY / ALPACA_SECRET       market data — without these the keyless
                                 endpoints rate-limit on the 1503-name universe
ALPHAVANTAGE_KEY / FINNHUB_KEY   optional fallbacks
FMP_KEY                          optional; enables PEAD/Insider/Analyst
```

Run **Refresh shared signals** manually once and confirm it succeeds.

> If your org enforces `iam.disableServiceAccountKeyCreation` you cannot create
> the JSON key. CI needs one; the VM does not (it uses ADC — step 5).

## 4. Automation settings (in the app)

Automation page:

- **Broker**: Alpaca, REST base `https://paper-api.alpaca.markets`
- **API key / secret**: your Alpaca paper keys
- Markets, tiers, indices, strategies — start narrow
- Risk: `riskPerTradePct`, `maxConcurrentPositions`, `minAdvUsd`
- **Enabled**: on

These live in Firestore, not on the VM. Change them later via the UI,
`npm run config`, or Telegram `/set`.

> `maxConcurrentPositions` is usually the binding constraint. In one dry run 8
> fully-qualified signals were turned away because all 4 slots were full.

## 5. The VM

SSH in (Cloud Console → Compute Engine → **SSH** button).

```bash
# Node 20 + git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# clone
cd ~ && git clone https://github.com/GoofyClub/swing-stocks.git
cd ~/swing-stocks && npm ci

# provision (idempotent — safe to re-run)
./scripts/setup-vm.sh
```

The script checks prerequisites, creates `~/swing-stocks/swing-config/swing.env` from the
generated template, verifies Firestore connectivity, and installs the systemd
units. It **cannot** grant Google Cloud permissions — the VM has no authority to
grant itself any — so it prints the exact Cloud Shell commands with your values
filled in.

### 5a. Google Cloud permissions (from **Cloud Shell**, not the VM)

Running these on the VM fails with `Request had insufficient authentication
scopes`, because there `gcloud` authenticates *as* the VM.

```bash
# Firestore access, ON THE FIREBASE PROJECT (often not the VM's project)
gcloud projects add-iam-policy-binding FIREBASE_PROJECT_ID \
  --member="serviceAccount:VM_SERVICE_ACCOUNT_EMAIL" \
  --role="roles/datastore.user"

# cloud-platform scope — requires the VM to be STOPPED, so do it outside market hours
gcloud compute instances stop INSTANCE --zone=ZONE
gcloud compute instances set-service-account INSTANCE --zone=ZONE \
  --service-account=VM_SERVICE_ACCOUNT_EMAIL --scopes=cloud-platform
gcloud compute instances start INSTANCE --zone=ZONE
```

Use `cloud-platform`, not something narrower: this command **replaces** the whole
scope list, and a narrow scope would strip whatever else the box runs on.

### 5b. Fill in the config

```bash
nano ~/swing-stocks/swing-config/swing.env
```

Minimum:

```bash
FIREBASE_PROJECT_ID=your-project-id
ALPACA_KEY=...            # market data (paper keys are fine)
ALPACA_SECRET=...
WATCHLIST_SET=broad       # 1503 names, matches refresh-signals
DRY_RUN=true
```

No Firebase credential line — with none set it uses the VM's own service account.
Every setting is documented in `config/swing.env.example`, generated from
`src/config/env.js`.

### 5c. Verify

```bash
./scripts/setup-vm.sh --check

cd ~/swing-stocks && set -a && . ~/swing-stocks/swing-config/swing.env && set +a
FORCE_WINDOW=true DRY_RUN=true npm run auto:sameday
```

You want:

```
using Application Default Credentials (GCE attached service account)
scanning US watchlist=1503 (set=broad) strategies=[rsi2,...]
US bars: 1495 ok, 8 failed (1%)
scanned 55 candidate signal(s) in 297s
skip AFL (rsi2): ADV 9M < min 20M          ← a real filter
DRYRUN would buy 3 CTAS @ market ~213.40   ← the line that proves the path works
```

**If you never see a `DRYRUN would buy` line, nothing has been proven.** Every
skip should name a rule you recognise. `tier null` or `index none` mean a bug.

## 6. Telegram bot (optional)

```bash
# token from @BotFather; message the bot once, then:
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'

cat >> ~/swing-stocks/swing-config/swing.env <<'EOF'
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=your-chat-id
EOF

sudo systemctl enable --now swing-bot
```

Send `/health`. Full command list in [telegram-bot.md](telegram-bot.md).

The allow-list is mandatory — the bot **refuses to start** without it rather than
defaulting to open, because it can `/flatten` your account.

## 7. Confirm the schedule

```bash
systemctl list-timers 'swing-*'
```

Two timers should be armed:

| Timer | ET | Does |
|---|---|---|
| `swing-sameday` | Mon–Fri 15:38 | entries at the close + exits |
| `swing-maintenance` | Mon–Fri 09:45, 16:15 | reconcile, exits, realize P&L, equity/drawdown |

Both must be running. The maintenance timer is not optional — without it orders
stay stuck at `submitted`, realized P&L never lands (which also blinds the
re-entry cooldown), and the drawdown peak freezes, silently disabling the halt.
See [architecture.md](architecture.md).

```bash
tail -f ~/swing-stocks/logs/swing.log         # after they fire
DRY_RUN=true npm run auto:maintenance         # force a pass now
```

Leave `DRY_RUN=true` for several sessions. Intended orders appear on the Auto
Orders page marked `DRY-RUN`, so you can review exactly what it would have done.

---

## Where everything is configured

| Layer | File / place | Examples | To change |
|---|---|---|---|
| Deployment | `~/swing-stocks/swing-config/swing.env` | credentials, `DRY_RUN`, `ALLOW_LIVE`, `WATCHLIST_SET`, dashboard auth | edit + `sudo systemctl restart swing-bot swing-dashboard` |
| Trading knobs | `src/config/trading.js` | close window, re-entry cooldown, order deadline | edit, commit, `git pull` on VM |
| Per-user risk | Firestore automation config | risk %, max positions, tiers, indices | UI / `npm run config` / `/set` |
| Strategy definitions | `src/strategy/normalize.js` | targets, stop bounds, hold periods | code change — see [strategies.md](strategies.md) |

## Routine operations

```bash
# update the VM copy (it does not follow main on its own).
# deploy.sh pulls fast-forward-only, runs the tests BEFORE restarting anything,
# and refuses to run inside the 15:38 ET execution window.
cd ~/swing-stocks && ./scripts/deploy.sh
./scripts/deploy.sh --check                 # see what it would do, change nothing

npm run config                              # show trading limits
npm run config maxConcurrentPositions 8     # change one

tail -f logs/swing.log                      # everything, live, one file
grep PLACED logs/swing.log | tail -20       # just the entries
./scripts/setup-vm.sh --check               # verify units + config paths agree
systemctl list-timers                       # schedules
```

Also from Telegram: `/deploy check`, then `/deploy CONFIRM`.

## 8. The log dashboard (optional)

One page showing the shared log live, plus timer/service state and today's
counts. It serves your trading activity, so it will not start without
credentials:

```bash
read -rs PW && printf '%s' "$PW" | sha256sum && unset PW   # copy the 64-char digest

cat >> ~/swing-stocks/swing-config/swing.env <<'EOF'
DASHBOARD_USER=admin
DASHBOARD_PASSWORD_HASH=<the digest>
DASHBOARD_PORT=8444
DASHBOARD_BIND=127.0.0.1
EOF

./scripts/setup-vm.sh --units
sudo systemctl enable --now swing-dashboard
```

It speaks plain HTTP, so basic-auth credentials cross the network in base64.
With `DASHBOARD_BIND=127.0.0.1` it is unreachable except through a tunnel:

```bash
ssh -L 8444:localhost:8444 YOUR_VM      # then open http://localhost:8444
```

Set `DASHBOARD_BIND=0.0.0.0` only behind a firewall rule that restricts the
source IP. It **cannot** share the ORB dashboard's port 8443 — one listening
socket belongs to one process; a second bind gets `EADDRINUSE`.

From Telegram: `/health`, `/status`, `/positions`, `/pnl`, `/log`, `/errors`,
`/pause`, `/resume`, `/flatten CONFIRM`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `RESOURCE_EXHAUSTED: Quota exceeded` | Firestore free-tier daily reads. Consider Blaze (step 1). |
| `Could not load the default credentials` | VM missing the `cloud-platform` scope (5a). |
| `PERMISSION_DENIED` on Firestore | Missing `roles/datastore.user` **on the Firebase project** (5a). |
| `Request had insufficient authentication scopes` from `gcloud` | You ran it on the VM. Use Cloud Shell. |
| `FIREBASE_PROJECT_ID must be set` | Config dir exists but `swing.env` doesn't (5b). |
| `TELEGRAM_BOT_TOKEN is required` in a restart loop, with the token clearly set | The unit's `EnvironmentFile` points at a path the config has since **moved away from** — systemd starts it with an empty environment, so *every* variable is missing and the error names only the first one checked. Run `./scripts/setup-vm.sh --check`: it compares each unit's `EnvironmentFile` against where the config actually is. Fix with `./scripts/setup-vm.sh --units && sudo systemctl restart swing-bot`. |
| Many `bars unavailable … blocked or timed out` | Keyless endpoints rate-limiting. Set `ALPACA_KEY`/`SECRET`. |
| `outside the 15:35-15:50 ET close window` | Timer fired late, or `OnCalendar` lacks `America/New_York`. |
| `DEADLINE: past 15:58 ET` | Scan outran the window. Fire earlier or use `core`. |
| `placed=0` with only recognisable skips | Working as intended — no signal passed your filters. |
| `tier null` / `index none` in skips | A bug. These should never occur. |

## Related

- [architecture.md](architecture.md) — what runs on the VM vs GitHub Actions, and why
- [logging.md](logging.md) — the single log file, the dashboard, `deploy.sh`
- [going-live.md](going-live.md) — `DRY_RUN`/`ALLOW_LIVE`, promotion checklist, security
- [same-day-execution.md](same-day-execution.md) — how the close runner works
- [telegram-bot.md](telegram-bot.md) — commands and security
- [strategies.md](strategies.md) — rules, parameters, measured performance
