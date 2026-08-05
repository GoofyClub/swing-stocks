# Same-day ("trade the close") execution

The scheduled worker (`auto-trade.mjs`) enters from the **previous** session's
finalised signals, so a signal fired on Monday's close is bought Tuesday morning.
Strategies modelled on the closing price lose part of their edge to that gap —
Connors RSI2 buys the oversold **close**, and by the next open the bounce has
often already started (you pay up) or the name gapped down (you buy into a
knife).

`scripts/same-day-trade.mjs` scans and enters the **same afternoon**, minutes
before the bell.

## Why not GitHub Actions

GitHub's cron is best-effort and on this repo has been observed starting **2-3
hours late** (see the comments in `.github/workflows/auto-trade.yml`). The
morning window is 3.5 hours wide and forgiving; the close window is **15
minutes** and is not. Run this on a machine whose clock you control.

## Why a market order, not market-on-close

Alpaca accepts market-on-close orders until ~15:50 ET and fills them at the
official close — exactly the price the strategy models. But **a bracket cannot
be attached to a MOC order**, so the position would sit unprotected overnight
until another run could attach a stop.

A plain **market order at ~15:45 with its bracket attached** fills within pennies
of the close *and* carries TP/SL from the moment it fills. That trade is worth
making. A limit order is the wrong instrument here: for a trade-the-close entry,
not filling means missing the trade, not getting a better price.

## Timing: will it actually fire in the window?

**Not on GitHub Actions — and it is built to fail safe there.** The runner checks
`inCloseWindow()` at startup and exits doing nothing if it is outside 15:35-15:50
ET. So a GitHub cron that fires 2 hours late does not place late trades; it
simply no-ops. That is deliberate: the wrong outcome is trading at the wrong
price, not missing a day.

**On a VM with a systemd timer, yes.** Timers fire within seconds of schedule.

Two timing details that matter:

- **Scan duration counts.** The runner fetches bars for every ticker before
  placing anything — measured at ~255 ms/symbol:

  | `WATCHLIST_SET` | US tickers | Scan time | Start the timer |
  |---|---|---|---|
  | `core` (default) | 51 | ~15 s | 15:42 |
  | `broad` | 1,503 | **~6-7 min** | **15:38** |

- **There is a hard per-order deadline at 15:58 ET.** The clock is re-checked
  before *every* order, not just at startup, so a slow scan stops placing rather
  than firing entries after the bell. If you see the `DEADLINE:` log line, start
  the timer earlier or shrink the watchlist.

## Market-data keys (effectively required for `broad`)

Bar fetching tries `alpaca` **first**, but only when credentials are present;
without them it falls through to keyless public endpoints. Those are fine for the
51-name `core` list and get **rate-limited** when hammered 1,503 times for
`broad`, which shows up as a burst of `bars unavailable … blocked or timed out`.

Your existing Alpaca **paper** keys work — market data is the free IEX feed, and
Alpaca is reliable from datacenter IPs (unlike the public endpoints):

```bash
cat >> ~/swing-config/swing.env <<'EOF'
ALPACA_KEY=your-alpaca-key
ALPACA_SECRET=your-alpaca-secret
EOF
```

These are for **market data only** — the broker credentials used to place orders
still come from each user's Firestore automation config.

The run reports fetch health so a silently-shrunken universe is visible:

```
US bars: 1487 ok, 16 failed (1%)
US bars: 1050 ok, 453 failed (30%) — HIGH. Likely rate-limiting …
```

## Matching the morning worker's universe

The two entry paths must scan the same names or they cannot be compared. The
runner defaults to `core` (51 names); `refresh-signals` is usually run with
`broad`, which for US means the **full S&P universe file (1,503 names)** — *not*
the 113-name broad watchlist. To match, add to `~/swing-config/swing.env`:

```bash
WATCHLIST_SET=broad
```

Confirm from the run's own log line, which prints the universe it actually used:

```
scanning US watchlist=1503 (set=broad) strategies=[rsi2,...]
```

If that says `watchlist=51`, the env var isn't reaching the process.



- **The signal is computed on a near-final price, not the settled close.** A
  late-session reversal can invalidate it. This is inherent to any trade-the-close
  system — Connors' own rule has the same practical issue — not a defect here.
- **The regime gate is not evaluated** on this path: no finalised intraday regime
  snapshot exists. The run logs this explicitly rather than silently skipping it.
- **Buy-stop strategies are excluded** (`pendingEntry`) — they need price to trade
  up through the entry trigger, which can't resolve in the final minutes. Those
  stay on the morning path.
- **Symbols already held are skipped.** Alpaca positions are per-symbol, so a
  second position on the same ticker would be indistinguishable to the exit model.

## Setup (Google Compute Engine VM)

Roughly 15 minutes. Steps 1-3 you may already have if the box runs other automation.

**1. Node 20+ and git**

```bash
node -v   # need >= 18; 20 matches CI
# if missing:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

**2. Clone and install**

Your home directory is fine and needs no `sudo` — only the timer units do. The
paths below use `$HOME`; substitute `/opt/swing-stocks` if you prefer a system
location (then the service needs `User=` set to whoever owns the checkout).

```bash
cd ~ && git clone https://github.com/GoofyClub/swing-stocks.git
cd ~/swing-stocks && npm ci
```

**3. Credentials — use the VM's own service account (no key file)**

Preferred, and required if your org enforces
`iam.disableServiceAccountKeyCreation`. The runner falls back to Application
Default Credentials, which on GCE is the VM's attached service account read from
the metadata server — nothing on disk to leak, rotate, or protect.

**3a. Identify the VM's service account** (run ON the VM):

```bash
curl -sH "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email
curl -sH "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/scopes
```

> **Run 3b and 3c from Cloud Shell, NOT from the VM.** On the VM, `gcloud` is
> authenticated *as* the VM's service account, which has neither the scopes nor
> the IAM rights to grant itself permissions — you get
> `Request had insufficient authentication scopes`. Cloud Shell (the `>_` icon in
> the console) is authenticated as *you*.

**3b. Grant Firestore access on the Firebase project.** This must target the
**Firebase** project, which is often *not* the project the VM lives in — compare
the project number in the service-account email against the Firebase project's:

```bash
gcloud projects add-iam-policy-binding FIREBASE_PROJECT_ID \
  --member="serviceAccount:VM_SERVICE_ACCOUNT_EMAIL" \
  --role="roles/datastore.user"
```

**3c. Give the VM the `cloud-platform` scope.** The default compute service
account ships with a narrow scope set that excludes Firestore, so this is
required even after 3b. Scopes cannot change while the VM runs — it must be
stopped, so **do this outside market hours** if the box runs other automation.

```bash
gcloud compute instances list          # find ZONE and INSTANCE_NAME

gcloud compute instances stop INSTANCE_NAME --zone=ZONE

gcloud compute instances set-service-account INSTANCE_NAME \
  --zone=ZONE \
  --service-account=VM_SERVICE_ACCOUNT_EMAIL \
  --scopes=cloud-platform

gcloud compute instances start INSTANCE_NAME --zone=ZONE
```

Use `cloud-platform`, not something narrower like `--scopes=datastore`: this
command **replaces** the entire scope list rather than adding to it, and
`cloud-platform` is a superset, so it cannot strip a scope other automation on
the box depends on.

**3d. Verify** — back on the VM:

```bash
# expect cloud-platform in the list
curl -sH "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/scopes
```

```bash
# expect roles/datastore.user  (Cloud Shell)
gcloud projects get-iam-policy FIREBASE_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:VM_SERVICE_ACCOUNT_EMAIL" \
  --format="value(bindings.role)"
```

**3e. Create the env file.** Still required even with ADC — it carries the
project id and the run flags. Creating only the directory and forgetting the file
gives `FIREBASE_PROJECT_ID must be set.`

```bash
mkdir -p ~/swing-config && chmod 700 ~/swing-config
cat > ~/swing-config/swing.env <<'EOF'
FIREBASE_PROJECT_ID=your-firebase-project-id
# Universe to scan. 'core' = 51 names (~15 s). 'broad' = the full S&P universe,
# 1503 names (~6-7 min) — use this to match what refresh-signals scans.
WATCHLIST_SET=core
# Optional: only improves market-data quality. Without them bar fetching falls
# back to other sources. These are NOT the broker credentials — those live in
# each user's Firestore automation config.
# ALPACA_KEY=...
# ALPACA_SECRET=...
DRY_RUN=true
EOF
chmod 600 ~/swing-config/swing.env
```

<details>
<summary>Alternative: an explicit key file (only if ADC isn't possible)</summary>

```bash
mv ~/service-account.json ~/swing-config/service-account.json
chmod 600 ~/swing-config/service-account.json
# and add to swing.env:
# FIREBASE_SERVICE_ACCOUNT_FILE=/home/srinathrn89/swing-config/service-account.json
```
</details>

**4. Prove it works before scheduling anything**

```bash
cd ~/swing-stocks
set -a && . ~/swing-config/swing.env && set +a
FORCE_WINDOW=true DRY_RUN=true npm run auto:sameday
```

`FORCE_WINDOW=true` bypasses the 15:35-15:50 gate so you can test at any hour;
`DRY_RUN=true` means nothing is submitted. You should see the scan run and
`DRYRUN would buy ...` lines. **Do not continue until this is clean** — debugging
credentials at 15:42 on a live afternoon is the thing to avoid.

**5. Schedule it** — units below.

## Setup (systemd timer, recommended)

Use a timer rather than crontab so the schedule is **timezone-aware**: a fixed UTC
cron drifts by an hour twice a year at the DST boundary, which for a 15-minute
window means firing outside it for months.

`/etc/systemd/system/swing-sameday.service`:

```ini
[Unit]
Description=Swing same-day (trade-the-close) execution
After=network-online.target

[Service]
Type=oneshot
# Run as the user who owns the checkout — NOT root. Replace both paths and the
# user if you installed somewhere else.
User=srinathrn89
WorkingDirectory=/home/srinathrn89/swing-stocks
EnvironmentFile=/home/srinathrn89/swing-config/swing.env
ExecStart=/usr/bin/node scripts/same-day-trade.mjs
```

Confirm the Node path with `which node` — if NodeSource put it somewhere other
than `/usr/bin/node`, use that in `ExecStart` (systemd needs an absolute path and
does not read your shell's `PATH`).

`/etc/systemd/system/swing-sameday.timer`:

```ini
[Unit]
Description=Fire the same-day runner just before the US close

[Timer]
# 15:42 ET, weekdays. Timezone-aware, so DST is handled for you.
OnCalendar=Mon-Fri 15:42 America/New_York
Persistent=false

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now swing-sameday.timer
systemctl list-timers swing-sameday.timer   # confirm the next fire time
```

`/etc/swing-stocks.env` (mode 600 — it holds credentials):

```bash
FIREBASE_PROJECT_ID=your-project-id
# No Firebase credential line: with none set the runner uses Application Default
# Credentials (the VM's attached service account). Only if you must use an
# explicit key, add FIREBASE_SERVICE_ACCOUNT_FILE=<path> — never paste the JSON
# inline, since systemd's EnvironmentFile mishandles the quotes in the blob.
ALPACA_KEY=...
ALPACA_SECRET=...
# Start in dry-run. Flip to false only after reviewing a dry-run's log.
DRY_RUN=true
```

## Rollout

1. **Dry-run first.** Leave `DRY_RUN=true` and let the timer fire for a few
   sessions. Each intended order is journalled with status `dryrun` and appears
   on the Auto Orders page, so you can review exactly what it would have done.
2. **Test off-window** any time with `FORCE_WINDOW=true DRY_RUN=true npm run auto:sameday`.
3. **Go live** by setting `DRY_RUN=false`. Real-money (non-paper) orders
   additionally require `ALLOW_LIVE=true` — the in-app flag alone can never place
   them.

## Keeping the VM copy current

The VM runs whatever it cloned — it does not follow `main` on its own. After
merging changes:

```bash
cd /opt/swing-stocks && git pull && npm ci
```

The timer picks up the new code on its next fire; no restart needed (the service
is `Type=oneshot`, started fresh each time).

## Troubleshooting

```bash
systemctl list-timers swing-sameday.timer   # next scheduled fire
journalctl -u swing-sameday.service -n 100  # last run's output
```

| Symptom | Cause |
|---|---|
| `service account key is not valid JSON` | Key pasted inline instead of via `FIREBASE_SERVICE_ACCOUNT_FILE`. |
| `Could not load the default credentials` | No key set and ADC unavailable — VM missing the `cloud-platform` scope (step 3c). |
| `PERMISSION_DENIED` on Firestore | Service account lacks `roles/datastore.user` **on the Firebase project** (step 3b). |
| `Request had insufficient authentication scopes` on a `gcloud` command | You ran it on the VM. Use Cloud Shell — see the note above step 3b. |
| `Service account key creation is disabled` | Org policy `iam.disableServiceAccountKeyCreation`. Expected — use ADC (step 3), no key needed. |
| Many `bars unavailable … blocked or timed out`, esp. on `broad` | Rate-limiting by the keyless public endpoints. Set `ALPACA_KEY` + `ALPACA_SECRET` — see below. |
| `only N historical bars available` for a few names | Benign. Recently-listed tickers without 220 bars of history; the scan skips them and continues. |
| `swing.env: No such file or directory` / `FIREBASE_PROJECT_ID must be set.` | Config dir created but the env file wasn't — step 3e. |
| `outside the 15:35-15:50 ET close window` | Timer fired late, or `OnCalendar` lacks `America/New_York`. |
| `DEADLINE: past 15:58 ET` | Scan outran the window — start earlier or use the `core` watchlist. |
| Nothing placed, no errors | Expected when no signal passes the filters. Check the `scanned N candidate(s)` line. |
| `RESOURCE_EXHAUSTED` | Firestore daily read quota — unrelated to the VM. |

## Interaction with the morning worker

Both paths can run. They share the same journal, guards and idempotency key, and
the same-day path skips symbols already held, so they will not double up on a
name. If you want same-day to be the *only* entry path for a strategy, remove it
from the morning worker's allow-list in Automation settings.

## Firestore cost

This path scans in-process from live bars and never reads or writes a signal
document, so it costs **no signal quota** — unlike the morning path, which reads
a finalised bucket.
