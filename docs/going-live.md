# Going live — where the switches are, and when to flip them

## The two switches

Both live in the env file (`~/swing-config/swing.env`), **not** in the app UI:

| Setting | Default | Effect |
|---|---|---|
| `DRY_RUN` | `true` | `true` logs intended orders and submits **nothing**. |
| `ALLOW_LIVE` | `false` | Hard gate for **real money**. Without it a live broker URL still refuses to trade. |

They are deliberately **independent**, so there is no single value that turns real-money trading on by accident:

| `DRY_RUN` | `ALLOW_LIVE` | Broker URL | Result |
|---|---|---|---|
| `true` | anything | anything | Simulated. Journalled as `dryrun`, nothing submitted. |
| `false` | `false` | paper | **Real orders on the paper account.** ← the goal for weeks |
| `false` | `false` | live | Refused, and logged. |
| `false` | `true` | live | **Real money.** |

The broker URL itself comes from your Firestore automation config (Automation
page → REST API base), not the env file. Paper is
`https://paper-api.alpaca.markets`.

```bash
# check what is currently set
grep -E 'DRY_RUN|ALLOW_LIVE' ~/swing-config/swing.env

# move from simulation to real PAPER orders
sed -i 's/^DRY_RUN=.*/DRY_RUN=false/' ~/swing-config/swing.env

# systemd re-reads EnvironmentFile on each start, and the runner is a oneshot
# timer job, so there is nothing to restart — the next fire picks it up.
```

## Promotion checklist

Do not skip a stage. Each one catches failures the previous cannot.

### Stage 1 — dry run on a timer (days)

- [ ] Timer installed and firing **inside** 15:35–15:50 ET (`systemctl list-timers`)
- [ ] `scanned N candidate(s)` looks sane, `US bars: … 0-2% failed`
- [ ] Every skip line is a rule you recognise
- [ ] `DRYRUN would buy …` lines appear — **if you never see one, nothing has been proven**
- [ ] Intended orders visible on the Auto Orders page as `DRY-RUN`

### Stage 2 — real orders, paper account (2–3 weeks minimum)

`DRY_RUN=false`, broker URL still paper.

- [ ] Orders actually **fill**, at prices close to the 15:45 mark
- [ ] Every fill carries its bracket (TP **and** SL visible at the broker)
- [ ] At least one trade closes via TP, one via SL, one via the 5-SMA/time exit
- [ ] Auto Orders shows win/loss, %, R and P&L for closed trades
- [ ] `/health`, `/positions`, `/pnl` agree with the Alpaca UI
- [ ] `/pause` demonstrably stops the next run; `/resume` restores it
- [ ] `/flatten CONFIRM` closes everything cleanly (test it deliberately once)
- [ ] Realized results are in the same ballpark as the backtest — **not** the
      Signal History page, which is a separate open question

### Stage 3 — live

Only after Stage 2 has run clean, and **only** with the security items below
addressed. Start with an account you can afford to lose entirely, and with
`maxConcurrentPositions` and `riskPerTradePct` set low.

```bash
sed -i 's/^ALLOW_LIVE=.*/ALLOW_LIVE=true/' ~/swing-config/swing.env
```

Then change the REST API base to `https://api.alpaca.markets` on the Automation
page. Both are required; neither alone trades real money.

## Security to address before Stage 3

**1. The VM can read every broker credential.** `roles/datastore.user` lets
anything on the box read `apiKey`/`apiSecret` out of your automation config. VM
compromise = broker compromise. Mitigations, cheapest first:

- Restrict SSH to your IP (firewall rule), disable password auth.
- Keep the box single-purpose; don't run untrusted code on it.
- Prefer a **broker key scoped to trading only** (no withdrawals) — Alpaca keys
  cannot transfer funds out, which is the main protection here.
- Longer term: move credentials to Secret Manager with a dedicated service
  account, so the trading SA can read secrets but not enumerate user documents.

**2. The Telegram bot is single-factor.** Chat-ID allow-list only, and it can
`/flatten`. If your Telegram account is compromised, so is the ability to
liquidate. Mitigations:

- Enable 2FA on your Telegram account (this is the real control).
- Keep `REPO_DIR` unset unless you actively want `/deploy`.
- Consider removing `/flatten` for a live account, since the broker UI is always
  available as a manual fallback.

**3. Everything is on one VM.** If it dies mid-session, open positions keep their
broker-side brackets (TP/SL are resting orders at Alpaca, not local state), but
the 5-SMA/time-stop exits stop running. Know that, and check in daily.

## Rollback

Fastest first:

```
/pause                  # Telegram: blocks all new entries immediately, persists
/flatten CONFIRM        # Telegram: close everything now
```

```bash
DRY_RUN=true            # in swing.env — next run simulates only
sudo systemctl disable --now swing-sameday.timer   # stop scheduling entirely
```

`/pause` is the right first move in almost every case: it stops new risk without
touching existing positions or their brackets.
