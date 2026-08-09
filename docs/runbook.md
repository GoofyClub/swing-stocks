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

The dashboard speaks plain HTTP, so basic-auth credentials would cross the
network in base64. With `DASHBOARD_BIND=127.0.0.1` it listens only on the VM's
loopback, and an SSH tunnel is the way in.

**Run the tunnel command on your LAPTOP, not on the VM.** Running it from the VM
just makes the VM connect to itself, which is what produces
`Permission denied (publickey)` — the VM has no key authorising itself.

```bash
# on your laptop — gcloud manages the keys for you
gcloud compute ssh instance-20260717-032820 --zone=YOUR_ZONE -- -L 8444:localhost:8444
```

Leave that session open, then browse to **http://localhost:8444**.

Plain `ssh -L 8444:localhost:8444 <ip>` also works, but only if you have already
added your own key to the instance; `gcloud compute ssh` does that step for you.

From **Cloud Shell** instead of a laptop:

```bash
gcloud compute ssh instance-20260717-032820 --zone=YOUR_ZONE -- -L 8444:localhost:8444
```

then use Web Preview → *Change port* → 8444.

With the tunnel in use, an ingress firewall rule for 8444 is unnecessary —
remove it.

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
REPO_DIR=/home/YOU/swing-stocks     # enables /deploy
```

The allow-list is mandatory — the bot refuses to start without it.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `TELEGRAM_BOT_TOKEN is required` looping, token clearly set | The unit's `EnvironmentFile` points where the config no longer is, so systemd starts it with an empty environment and the error names only the first missing key. `./scripts/setup-vm.sh --check` compares them; fix with `--units` and restart. |
| `FIREBASE_PROJECT_ID must be set` on a manual run | Old code. The scripts now read `swing.env` themselves — `git pull`. |
| `order not found` on realize | The order object is gone (paper reset, or an id written under a different account). Realization now falls back to fill history; only a trade with no matching fills is written off. |
| `RESOURCE_EXHAUSTED: Quota exceeded` | Firestore free-tier daily reads. Consider Blaze. |
| `Could not load the default credentials` | VM missing the `cloud-platform` scope. |
| `PERMISSION_DENIED` on Firestore | Missing `roles/datastore.user` **on the Firebase project**. |
| `Permission denied (publickey)` from the tunnel | You ran `ssh -L …` on the VM. Run it on your laptop, or use `gcloud compute ssh`. |
| `EADDRINUSE` on the dashboard | Port taken (ORB uses 8443). Set `DASHBOARD_PORT`. |
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
