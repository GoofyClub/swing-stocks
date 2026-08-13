# Runbook — every command, in one place

Operational reference for a VM that is already set up. For a first-time install
see [setup.md](setup.md); for what runs where see
[architecture.md](architecture.md).

Paths below assume the standard layout:

```
~/swing-stocks/                    the checkout
~/swing-stocks/swing-config/       swing.env (gitignored, chmod 600)
~/swing-stocks/logs/swing.log      the one log file
```

---

## Validate everything

One read-only command. Places no orders, cancels nothing, writes nothing — so
it is safe to run at any time, including mid-session.

```bash
cd ~/swing-stocks
npm run validate              # full: includes the test suite and a live bar fetch
npm run validate -- --quick   # skip those two (a few seconds)
```

From Telegram: `/validate` (quick) or `/validate full`.

Exit code 0 = healthy, 1 = something needs attention. It checks node, the
config file and its permissions, both timers, all four units' `EnvironmentFile`
paths, Firestore reachability and recent worker runs, every enabled broker
account, market-data fetching, the log file, the dashboard's bind address, and
whether the checkout is behind origin or has a red test suite.

The part worth reading is section 4, which cross-checks the broker against the
order journal:

| Finding | Why it matters |
|---|---|
| **untracked position** | The exit pass iterates the journal, so a position with no doc is never evaluated for a native/time/trailing exit. It rides on its hard stop alone, indefinitely. |
| **stuck at 'submitted'** | Reconciliation is not running, which also hides the position from exit management. |
| **closed but unrealized** | The re-entry cooldown reads `realizedWinLoss`; without it, a name that just stopped out can be re-bought immediately. |
| **stale equity snapshot** | The drawdown peak is a persisted ratchet. Frozen, it makes drawdown look *smaller* than reality — the halt silently stops firing. |
| **duplicate open docs** | Broker positions are per-symbol, so exiting one doc liquidates the whole holding. |
| **ghost fill** | Journal says filled, broker holds nothing. Normal for minutes after an exit; persistent means maintenance is not reconciling. |

These rules are pure and unit-tested (`tests/integrity.mjs`) — a false "all
clear" would be worse than no check, since it is an explicit assurance that no
unprotected position exists.

## Turning a market off

`MARKETS` in `swing-config/swing.env` is the single switch — it gates scanning
**and** trading, intersected with each user's configured markets, so one setting
turns a market off everywhere:

```bash
MARKETS=US            # default: NSE is not scanned or traded
MARKETS=US,INDIA      # when you start trading NSE
```

This is not just tidiness. A market you do not trade still costs a full universe
scan and — expensively — its own re-settlement query, per refresh run. That is
what exhausted the Firestore daily allowance and stopped the entry runner.

Two places to change when you add NSE back:

1. `MARKETS=US,INDIA` in `swing.env` (the VM)
2. the `MARKETS` repo variable, or the `refresh-signals` workflow default, plus
   restoring its `0 11 * * 1-5` cron for the NSE end-of-day pass

The runners log what they dropped, so a market silently missing is visible:

```
skipping INDIA — not in MARKETS for this deployment (US)
```

## Daily checks

```bash
cd ~/swing-stocks

systemctl list-timers 'swing-*'       # both timers armed?
tail -f logs/swing.log                # everything, live
grep PLACED logs/swing.log | tail -20 # today's entries
grep -E 'ERROR|WARN' logs/swing.log | tail -20
./scripts/setup-vm.sh --check         # units, config path, IAM, connectivity
```

From Telegram: `/health`, `/status`, `/positions`, `/pnl`, `/log 40`,
`/log 40 PLACED`, `/errors`.

## Running things by hand

The scripts read `swing-config/swing.env` themselves, so **no `set -a && . swing.env`
step is needed**. Anything already in your shell wins, so inline overrides work.

```bash
# maintenance: reconcile → exits → realize → equity
DRY_RUN=true npm run auto:maintenance

# the entry runner, bypassing the 15:35–15:50 ET window, submitting nothing
FORCE_WINDOW=true DRY_RUN=true npm run auto:sameday

# restrict either to one account
ONLY_UID=<uid> DRY_RUN=true npm run auto:maintenance

# trading limits (these live in Firestore, not on this box)
npm run config                            # show
npm run config maxConcurrentPositions 8   # change one
```

## Deploying

```bash
./scripts/deploy.sh            # pull, install, test, restart what changed
./scripts/deploy.sh --check    # report only
./scripts/deploy.sh --force    # restart anyway / inside the window
```

From Telegram: `/deploy check`, then `/deploy CONFIRM`.

It refuses on a dirty tree, refuses inside 15:30–16:05 ET, and refuses to
restart anything if the test suite is red — the old code keeps running instead.

## Services

```bash
sudo systemctl restart swing-bot
sudo systemctl restart swing-dashboard
sudo systemctl status swing-bot

./scripts/setup-vm.sh --units          # rewrite the unit files after a pull
sudo systemctl start swing-maintenance # fire a maintenance pass now
```

The two `oneshot` runners have no daemon to restart — `swing-sameday` and
`swing-maintenance` pick up new code at their next firing.

---

## The dashboard

### Setting the password

You choose the password; the config stores only its SHA-256 digest.

```bash
read -rs PW && printf '%s' "$PW" | sha256sum && unset PW
```

Type the password (it does not echo), press Enter. The output looks like
`9f86d081…b0f00a08  -` — copy **only the 64 hex characters**, not the trailing
` -`.

Use `read -rs` rather than `echo -n 'mypassword' | sha256sum`, which would put
the password in your shell history.

Then add to `swing-config/swing.env`:

```bash
DASHBOARD_USER=admin
DASHBOARD_PASSWORD_HASH=<the 64 hex chars>
DASHBOARD_BIND=127.0.0.1
DASHBOARD_PORT=8444
```

```bash
./scripts/setup-vm.sh --units
sudo systemctl enable --now swing-dashboard
```

### Reaching it

Three options. Pick one.

#### A. Direct, over HTTPS — `https://<vm-ip>:8444`

No tunnel, works from any browser. The self-signed cert encrypts the
connection; the browser warns once because nobody vouches that the host is
yours, which is an *identity* warning, not an encryption one. For a host whose
IP you typed in yourself, clicking through is reasonable.

```bash
cd ~/swing-stocks
npm run dashboard:cert -- --apply       # cert + writes the settings into swing.env
sudo systemctl restart swing-dashboard
ss -ltn | grep 8444                     # want 0.0.0.0:8444, NOT 127.0.0.1:8444
```

`--apply` backs up `swing.env` first, then sets `DASHBOARD_BIND=0.0.0.0` and the
two cert paths. Without it the script only prints them for you to paste — and
generating a cert while leaving `DASHBOARD_BIND=127.0.0.1` is the trap: the
service stays on loopback and the browser times out exactly as if the firewall
were wrong.

`ss` is the check that matters. Config says what you asked for; `ss` says what
the kernel actually bound, and a restart that silently failed leaves the old
address in place.

Then the firewall. **Scope it to your own IP** — an open 8444 gets found by
scanners within hours, and while they can't get past the password, they can
burn the lockout and fill your log:

```bash
curl -s ifconfig.me      # your current public IP

gcloud compute firewall-rules create swing-dashboard \
  --allow=tcp:8444 --source-ranges=YOUR.IP.HERE/32 \
  --target-tags=swing-dashboard --description="Swing log dashboard"

gcloud compute instances add-tags INSTANCE --zone=ZONE --tags=swing-dashboard
```

That last step is the one people miss. A rule with `--target-tags` matches
**nothing** until the instance carries the tag, and the symptom is a connection
**timeout** — indistinguishable from "the service isn't running". Check with:

```bash
gcloud compute instances describe INSTANCE --zone=ZONE --format='get(tags.items)'
```

For a rule that applies to every instance instead, drop `--target-tags`.

Browse to **https://34.23.154.110:8444** — note **https**, not http. Plain HTTP
against the TLS port fails with an empty response rather than a useful error.

#### B. Direct, over plain HTTP

Same as A without the cert: set `DASHBOARD_BIND=0.0.0.0`, leave the cert
variables unset, add the firewall rule. Your password and every log line then
cross the internet in base64, readable by anything in between. Only worth doing
behind a `--source-ranges` rule, and A costs one extra command.

#### C. Tunnel — nothing exposed at all

Keep `DASHBOARD_BIND=127.0.0.1`; the port is never open. Run this **on your
laptop, not on the VM** — from the VM it dials itself and fails with
`Permission denied (publickey)`:

```bash
gcloud compute ssh INSTANCE --zone=ZONE -- -L 8444:localhost:8444
```

Leave it open, browse to `http://localhost:8444`. `gcloud compute ssh` handles
key provisioning; plain `ssh -L` works only if your key is already on the
instance.

---

## Firestore rules

The CLI pre-flights "is the Firestore API enabled?", which needs project-level
permission. If you are signed in as an account that does not own the Firebase
project you get:

```
403 Permission denied to get service [firestore.googleapis.com]
```

The API is already enabled — you are blocked by the *check*, not the deploy.
Two ways round it:

**Console (no permissions needed).** Firebase Console → your project → Firestore
Database → **Rules** → paste `firestore.rules` → **Publish**.

**CLI, as the owning account.**

```bash
npx firebase-tools login --reauth        # sign in as the account that owns the project
npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT
```

Note the package is `firebase-tools`, not `firebase` — `npx firebase` fails with
*could not determine executable to run*.

---

## Google Cloud permissions

These must run from **Cloud Shell**, not the VM: on the VM `gcloud`
authenticates *as* the VM, which fails with `Request had insufficient
authentication scopes`.

```bash
# Firestore access, ON THE FIREBASE PROJECT (often not the VM's project)
gcloud projects add-iam-policy-binding YOUR_FIREBASE_PROJECT \
  --member="serviceAccount:VM_SERVICE_ACCOUNT_EMAIL" \
  --role="roles/datastore.user"

# cloud-platform scope — the instance must be STOPPED, so do it outside market hours
gcloud compute instances stop INSTANCE --zone=ZONE
gcloud compute instances set-service-account INSTANCE --zone=ZONE \
  --service-account=VM_SERVICE_ACCOUNT_EMAIL --scopes=cloud-platform
gcloud compute instances start INSTANCE --zone=ZONE
```

`setup-vm.sh` prints both with your real values substituted.

---

## Telegram

```bash
# chat id — message the bot once first
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'
```

```bash
# in swing-config/swing.env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=your-chat-id
```

`/deploy` needs no configuration — the bot deploys the checkout it is running
from. `REPO_DIR` only overrides that (for a bot running outside the repo it
deploys), and `DEPLOY_ENABLED=false` turns the command off.

The allow-list is mandatory — the bot refuses to start without it.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `TELEGRAM_BOT_TOKEN is required` looping, token clearly set | The unit's `EnvironmentFile` points where the config no longer is, so systemd starts it with an empty environment and the error names only the first missing key. `./scripts/setup-vm.sh --check` compares them; fix with `--units` and restart. |
| `FIREBASE_PROJECT_ID must be set` on a manual run | Old code. The scripts now read `swing.env` themselves — `git pull`. |
| `order not found` on realize | The order object is gone (paper reset, or an id written under a different account). Realization falls back to fill history; the log says which of "symbol absent from fills", "still open", or "entry price doesn't match" applies. Once fixed, re-examine written-off trades with `REALIZE_RETRY=true npm run auto:maintenance`. |
| `RESOURCE_EXHAUSTED: Quota exceeded` | Firestore free-tier daily reads. The historical cause was `refresh-signals`: it ran 17×/day and each run re-read every signal in a 120-day window, per market — hundreds of thousands of reads against a 50k limit, exhausting it by mid-afternoon and killing the 15:38 ET **entry** run. Now 4 runs/day, and routine passes only re-read OPEN signals. Set `RESETTLE_ALL=true` for a one-off full re-grade after a `SETTLEMENT_VERSION` bump. Blaze removes the limit entirely. |
| `Could not load the default credentials` | VM missing the `cloud-platform` scope. |
| `PERMISSION_DENIED` on Firestore | Missing `roles/datastore.user` **on the Firebase project**. |
| `Permission denied (publickey)` from the tunnel | You ran `ssh -L …` on the VM. Run it on your laptop, or use `gcloud compute ssh`. |
| `EADDRINUSE` on the dashboard | Port taken (ORB uses 8443). Set `DASHBOARD_PORT`. |
| Dashboard connection **times out** from a browser | Firewall. Usually a `--target-tags` rule whose tag the instance doesn't carry — check with `gcloud compute instances describe INSTANCE --zone=ZONE --format='get(tags.items)'`. A timeout means blocked; "connection refused" would mean the service is down. |
| Dashboard gives an empty reply | You used `http://` against a TLS-enabled port. Use `https://`. |
| `outside the 15:35-15:50 ET close window` | Timer fired late, or `OnCalendar` lacks `America/New_York`. |
| `DEADLINE: past 15:58 ET` | Scan outran the window. Fire earlier or use `WATCHLIST_SET=core`. |
| `placed=0` with recognisable skips | Working as intended — nothing passed your filters. |
| `tier null` / `index none` in skips | A bug. These should never occur. |

---

## Going from dry-run to real paper orders

`DRY_RUN=true` in `swing.env` applies to **both** runners. That means exits are
simulated too: a position you already hold gets checked and then not acted on,
riding on its hard stop alone. There is no separate switch for entries vs exits.

```bash
nano swing-config/swing.env      # DRY_RUN=false
sudo systemctl restart swing-bot swing-dashboard
```

Real money needs `ALLOW_LIVE=true` **and** a live broker URL in the automation
config — see [going-live.md](going-live.md). Neither alone is enough.
