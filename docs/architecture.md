# What runs where

The VM owns trading. GitHub Actions owns signals. Nothing that touches an order
runs on a timer in Actions.

## The VM (authoritative)

| Unit | Schedule (ET) | Does |
|---|---|---|
| `swing-sameday.timer` | Mon–Fri 15:38 | Scan → entries at the close → exit pass |
| `swing-maintenance.timer` | Mon–Fri 09:45 and 16:15 | Reconcile → exit pass → realize outcomes → equity/drawdown snapshot |
| `swing-bot.service` | always | Telegram control panel |
| `swing-dashboard.service` | always | Log dashboard on :8444 |

## GitHub Actions (signals only)

| Workflow | Schedule | Does |
|---|---|---|
| `refresh-signals.yml` | every 30 min, US hours | Scan the core watchlist, write signals to Firestore |
| `refresh-broad.yml` | 17:30 ET | Scan the 1503-name universe after the close |
| `refresh-universe.yml` | Sat 08:00 UTC | Rebuild S&P 500/400/600 membership |
| `deploy.yml` | on push to main | Publish the SPA to Pages |
| `auto-trade.yml` | **manual only** | Legacy morning-entry path. Escape hatch when the VM is down. |
| `backtest-stop.yml` | manual only | Stop-width study |

## Why the split moved

Execution used to straddle both. Entries fired on the VM at 15:38; order
reconciliation, exit management, realized-P&L journaling and the equity snapshot
ran in Actions. Two schedulers, two code copies, two failure modes.

GitHub cron is fixed-UTC (so it drifts an hour twice a year) and explicitly
best-effort. On this repo, scheduled runs have started **2–3 hours late**, been
**cancelled** mid-run, and **failed to allocate a runner at all** — one sat 15
minutes with `runner_id: 0` and then died. For a signal refresh that is fine:
the next run fixes it, and a stale signal just doesn't get traded.

For the post-trade pipeline it is not fine, because each missed run breaks
something that stays broken:

- **Reconciliation missed** → the order stays `submitted`. The exit pass only
  looks at `filled` docs, so the position becomes invisible to exit management —
  it holds with nothing but its hard stop. And the stale-entry sweep never runs,
  so an unfilled GTC entry limit can fill days later at a price the signal no
  longer justifies.
- **Realization missed** → no `realizedWinLoss`, so the Auto Orders page shows
  nothing *and* the re-entry cooldown goes blind (it reads exactly that field).
  The system would happily re-buy a name it just got stopped out of.
- **Equity snapshot missed** → the drawdown peak is a ratchet persisted in
  Firestore, not a windowed recomputation. If it stops being written it freezes
  at its last value, which makes the measured drawdown look *smaller* than it
  is — so the halt that exists to stop the bleeding quietly stops firing. This
  is the worst of the three, because it fails silently and in the unsafe
  direction.

Since the trade-the-close entry is what the strategy actually models (see
[same-day-execution.md](same-day-execution.md)), the morning path was not worth
keeping on a schedule at all.

## What makes this safe to run in two places

Every step is idempotent, so the manual Actions workflow and the VM timers
cannot corrupt each other if both run:

- entries use a deterministic `client_order_id` — a duplicate submit collides at
  the broker instead of doubling the position
- the exit pass short-circuits on `exit_submitted`
- realization skips any doc that already has `realizedWinLoss`
- the equity snapshot is keyed by date and merges

That is also why the maintenance timer is `Persistent=true` while the entry
timer is `Persistent=false`: a missed maintenance run *should* catch up on boot,
whereas a missed 15:38 entry window must never fire late — the close has passed
and the price the strategy modelled is gone.

## Shared modules

Both runners call the same code, so a behaviour can't exist in one path and not
the other:

```
scripts/lib/exit-pass.mjs    native / time-stop / trailing exits
scripts/lib/reconcile.mjs    order status refresh + stale-entry sweep
scripts/lib/realize.mjs      realized %, R, $ P&L, win/loss
scripts/lib/equity.mjs       equity snapshot + drawdown ratchet
scripts/lib/logfile.mjs      the one log file
```

## Verifying

```bash
systemctl list-timers 'swing-*'          # both timers armed?
./scripts/setup-vm.sh --check            # units, config path, IAM, connectivity
tail -f logs/swing.log                   # everything, live

# force a maintenance pass without waiting for the timer
DRY_RUN=true npm run auto:maintenance
```

From Telegram: `/health` reports both timers.
