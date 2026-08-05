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

## Known limitations

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
WorkingDirectory=/opt/swing-stocks
EnvironmentFile=/etc/swing-stocks.env
ExecStart=/usr/bin/node scripts/same-day-trade.mjs
```

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
FIREBASE_PROJECT_ID=...
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
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

## Interaction with the morning worker

Both paths can run. They share the same journal, guards and idempotency key, and
the same-day path skips symbols already held, so they will not double up on a
name. If you want same-day to be the *only* entry path for a strategy, remove it
from the morning worker's allow-list in Automation settings.

## Firestore cost

This path scans in-process from live bars and never reads or writes a signal
document, so it costs **no signal quota** — unlike the morning path, which reads
a finalised bucket.
