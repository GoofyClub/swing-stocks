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

- **Scan duration counts.** The runner fetches bars for every ticker in the
  watchlist before placing anything: roughly 0.2-0.4 s per symbol, so ~20-30 s for
  the `core` list (~50 US names) but **many minutes** for `broad` (~1,500). Start
  the timer at **15:42** with the `core` watchlist and it finishes comfortably.
- **There is a hard per-order deadline at 15:58 ET.** The clock is re-checked
  before *every* order, not just at startup, so a slow scan stops placing rather
  than firing entries after the bell. If you see the `DEADLINE:` log line, start
  the timer earlier or shrink the watchlist.



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

**3. Credentials**

Put the Firebase service-account key on disk as a *file* (see the env note below
for why), and lock it down:

```bash
mkdir -p ~/swing-config && chmod 700 ~/swing-config
mv ~/service-account.json ~/swing-config/service-account.json
chmod 600 ~/swing-config/service-account.json ~/swing-config/swing.env
```

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
# Point at the key FILE. Do NOT paste the JSON inline: systemd's EnvironmentFile
# is not a shell and mishandles the quotes in the blob, which fails at parse time
# on a trading afternoon rather than when you set it up.
FIREBASE_SERVICE_ACCOUNT_FILE=/etc/swing-stocks/service-account.json
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
