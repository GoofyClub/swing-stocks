# RSI2 bot on your own PC — beginner guide

This is the **Swing RSI2 bot**, separate from ORB. It runs one US-stock Alpaca
**paper** account. No Firebase, Google Cloud, service account, subscription,
website login, or cloud database is required. Your PC runs the schedule,
Telegram bot and dashboard; its `data` folder holds the trade journal and controls.
Alpaca and Telegram still need Internet access. The original multi-user web app
is legacy code and is not started or installed by this package. Its Firebase
refresh jobs and GitHub Pages deployment are now manual-only.

## Before you start

- Windows 10/11 with virtualization/WSL2 support and permission to install software.
- A dedicated Alpaca **paper** account and its paper API key and secret.
  Use a different account for ORB; account-wide risk limits and `/flatten` cover
  every position in this account.
- A **different Telegram bot token** from your ORB bot (create one with @BotFather),
  and your numeric Telegram chat ID. Open your new bot and press Start.
- Stop the old RSI2 scheduler/bot first. Close its positions and cancel old orders
  in Alpaca. The new local journal does not import Firebase positions or settings.
- Keep the PC plugged in, awake, connected to the Internet, with Docker Desktop
  running. After reboot, sign into Windows so Docker Desktop can start.

## Install — double-click one file

1. Download this repository from GitHub (Code → Download ZIP) and extract it.
2. Double-click **Install-Swing.cmd**. Accept Windows installer prompts. It installs
   Git, Docker Desktop/WSL and Tailscale when needed. A restart may be required:
   restart Windows, open Docker Desktop, and run the same file again.
3. Type `YES` only after the old RSI2 bot is stopped and its paper account is flat.
4. Enter the paper Alpaca key/secret, new Telegram token, chat ID, and a dashboard
   username/password. Passwords and keys are hidden while typing.
5. Sign into Tailscale with the same account you use on your phone.
   On its approval page **enable HTTPS certificates and Serve; leave Funnel OFF**.
   HTTPS publishes your device hostname in certificate transparency logs.
6. Choose whether to prevent sleep/hibernation while plugged in. The installer
   prints **VERIFIED** when Windows confirms the settings. Battery and lid-close
   settings are separate; keep the laptop plugged in with the lid open.
7. Save the remote dashboard address printed by the installer. It ends in
   `:8444`, so ORB can keep using HTTPS port 443 on the same PC.

The installer may create a Git checkout in `C:\Users\YOURNAME\Swing-PC` when run
from a ZIP. Its final output identifies the active folder. Use that folder for
all edits and commands below. Re-running preserves your credentials and journal.

## Check before enabling paper orders

1. In Telegram send `/healthcheck`, `/positions`, `/config`, and `/status`.
2. Visit `http://127.0.0.1:8444` on the PC. Log in with your dashboard credentials.
   On your phone, connect Tailscale and open the printed HTTPS address.
3. New installations are **PAUSED** and **DRY_RUN=true**. Review `/config`: these
   are fresh local defaults, not your old Firebase settings. Safety filters also
   require verified earnings coverage; see **Earnings and market-event review**
   below before enabling entries. `/set riskPerTradePct
   0.25` is an example of a supported numeric setting. Other settings can be
   placed in `data/config.json`; use the names shown by `/config` and valid JSON.
4. When ready, open `swing-config\swing.env` in Notepad in the active folder.
   Change `DRY_RUN='true'` to `DRY_RUN='false'`. Keep credentials private.
5. Open PowerShell in that folder and run:

   ```powershell
   & "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe" compose up -d --force-recreate --wait
   ```

   If Docker was installed just for your user, use
   `$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe` instead.
   Or open a new terminal and use `docker compose ...` when Docker is on PATH.
6. Send `/resume`, then `/status` to confirm PAPER orders enabled. Resume alone
   cannot turn off dry-run. Live trading is not supported by this package.

Pausing blocks **new entries**; exits continue when dry-run is off. Broker stops
remain at Alpaca even if the PC stops, but indicator/time exits need the PC.

## After a PC restart

Do not run the installer again. Sign into Windows and wait for Docker Desktop
and Tailscale to start. Docker restarts both installed bot containers automatically
(`restart: unless-stopped`). Keep Docker Desktop enabled at sign-in; the installer
adds a startup shortcut. Send `/healthcheck` to each bot. If you deliberately
stopped a container, start it again with `docker compose up -d` in its own folder.
Your pause setting and dry-run choice are preserved; a restart does not resume
a paused bot. Automation cannot run while the PC is asleep or Docker is stopped.

## What runs and when

The existing RSI2 strategy, sizing/selection guards, managed indicator/time exits,
order reconciliation and actual-fill P&L functions are reused. This local worker
uses Alpaca IEX bars (free feed; results can differ from consolidated SIP data).
It scans the bundled broad US universe near 15:38 New York time (15:42 for core),
with no new entries after the existing 15:50 cutoff. Maintenance runs at 09:45 and
16:15. Times adjust for daylight saving; Alpaca's clock blocks entries on closed
sessions. A missed entry window is skipped. Interrupted jobs retry with the same
order IDs. An uncertain submission with no broker match blocks new entries until
reviewed; inspect Alpaca before resolving its journal record.

## Useful Telegram commands

`/help`, `/status`, `/healthcheck`, `/positions`, `/pnl`, `/config`, `/pause`,
`/resume`, `/set <key> <number>`, `/deploycheck`, `/deploy CONFIRM`,
`/flatten CONFIRM`.

`/flatten CONFIRM` closes **all** positions in the dedicated paper account when
paper execution is enabled. Verify `/positions` until flat. `/deploy` updates
from GitHub main with a fast-forward and offline tests. Docker/Compose changes
require a PC rebuild. For private repository updates, configure the optional
`SWING_GITHUB_TOKEN` in the private env file with repository read access.
Never share that file.

## Change keys / troubleshoot

Edit `swing-config\swing.env` locally and recreate the container as above.
Do not send keys in Telegram or upload the env file. For diagnostics:

```powershell
docker compose ps
docker compose logs --tail=100
docker compose exec -T swing python3 packaging/runtime.py verify
```

`verify` checks Alpaca and Telegram without submitting orders. A failed check
leaves a new installation paused. Save a copy of the private env file and the
whole `data` folder while the container is stopped. Move both to migrate machines;
run only one installation for this paper account. Do not delete `data` to update.

Linux/macOS: install Docker with Compose, then run `bash start-swing.sh`.
For private remote access, install/sign into Tailscale separately and run
`tailscale serve --bg --https=8444 http://127.0.0.1:8444`. Keep Funnel off.

## If installation fails with “No system certificates available”

Update the RSI2 checkout from main, then rerun its installer:

```powershell
git pull --ff-only origin main
.\Install-Swing.cmd
```

Run these commands in the active RSI2 Git checkout (often `$HOME\Swing-PC`),
not the ORB folder or a downloaded ZIP. Existing credentials and `data` are
preserved. The fixed Dockerfile installs trusted certificates using Debian's
signed package repositories before switching them to HTTPS. Do not disable
certificate checks or delete your saved configuration to work around this error.

## Validation of this package

The Docker image is built without installing npm packages. Its offline tests
cover paused/dry-run behavior, protected RSI2 entry and duplicate prevention,
accepted-order recovery, local journal updates, Telegram authorization and
confirmation, and dashboard authentication. A network-disabled container restart
checks supervisor startup and persisted controls. Scheduler tests cover DST and
missed entry windows; PowerShell helper tests cover installer parsing, package
recognition, Tailscale conflicts and power-setting verification. The full legacy
strategy test suite and web build also pass. A complete Windows installation and
real Alpaca/Telegram connectivity still need verification on your PC with your
credentials; no broker orders were placed during development testing.

## Start after reboot without a person signing in

The containers already use `restart: unless-stopped`: they start when the Docker
engine starts, with their saved paused/resumed state. No daily trading trigger or
installer run is needed. A container deliberately stopped with Stop stays stopped
until Start is selected. Pausing only blocks new entries; it survives restarts.

**Windows Docker Desktop:** the current installer starts Desktop at Windows
sign-in. The Docker Windows service alone does not reliably start its Linux
engine before sign-in. A Task Scheduler job that runs `docker compose up` before
that engine exists does not solve this.

For the least change to your Windows PC, you can configure Microsoft's
[Sysinternals Autologon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon)
locally, following its instructions. Windows then signs in automatically and the
Docker startup shortcut starts both bots. Configure credentials only in that
Microsoft utility, never in bot scripts or Git. This automatically opens your
Windows session to someone with physical access to the PC. It also cannot bypass
a firmware or disk-encryption password required before Windows boots. This option
is not enabled by our installer.

For operation **without any Windows sign-in**, run the bots on a Linux machine
(or a Linux VM configured by your hypervisor to boot automatically with the host).
After installing [Docker Engine with Compose](https://docs.docker.com/engine/install/ubuntu/),
enable its boot service:

```bash
sudo systemctl enable --now docker
```

Install each bot once with its `start-*.sh` helper. Docker then restores its
containers at boot even while the Linux login screen is displayed. Install
Tailscale on that host and keep its daemon enabled at boot for remote access.
A Linux VM inside a desktop application that itself starts at sign-in still has
the same sign-in dependency. Keep the host and VM awake and network-connected.

## Controls without opening Docker Desktop

Double-click the `Control-Swing.cmd` file for this bot and choose Status, Pause,
Resume, Restart, Start or Stop. Docker's engine must already be running; its
window can remain closed. Restart recreates the container to apply saved env
settings and waits for the running worker to finish. It preserves your state and
does not rebuild images or download code. Use the installer/update guide for
code or image updates.

Pause keeps the scheduler, Telegram bot, dashboard and managed exits running;
Resume preserves the configured dry-run setting. Stop shuts down all bot
processes, including managed exits. Existing Alpaca orders stay at the broker.
Use Pause when you only want to stop new trades. If a command fails, the menu
shows CONTROL FAILED rather than claiming success.

When the bot is running, Telegram `/pause`, `/resume`, `/status` and
`/healthcheck` also work without using Docker Desktop. Telegram cannot restart a
stopped container, because its bot process is stopped too. Use the control file
on the PC for that.

## RSI2 dashboard

The dashboard uses the same light/dark layout as ORB: runtime status, paper
account equity and day change, a 7/30/90-day equity chart, monthly P&L calendar
with weekly totals and selected-day details, open positions, trade history,
active risk settings and recent logs. Theme choice is saved in your browser.

The calendar includes only broker-confirmed results from the local journal,
grouped by the date the result was recorded (which may be after the actual
exit). It does not import the old Firebase journal. The equity chart comes
from Alpaca account history, including cash and open positions. Data failures
show as unavailable or stale; pending outcomes are not counted as wins or losses.
Trade-history controls filter the latest 200 journal entries by entry session.

To update an existing installation, open PowerShell in the active RSI2 checkout:

```powershell
git pull --ff-only origin main
.\Control-Swing.cmd Restart
```

Then refresh the dashboard page. Existing credentials, journal and pause setting
are preserved. Dashboard-only updates do not require rebuilding the image.

## Safety update: exit recovery and allocation limits

The local bot now checks actual Alpaca positions and protective orders every
minute from **09:25–16:30 New York time on weekdays**, and every 15 minutes
otherwise. These passes are serialized with scans and maintenance: a running
entry scan can delay the next safety pass. Checks run while new entries are
paused; they cannot run when the PC or Docker is stopped.

A missing stop on a tracked holding triggers a managed liquidation. Exit intent
is saved before canceling orders. Retries use a stable client order ID so a lost
response does not become another sale. The controller checks existing market
sells, waits for reservations to release, and uses the broker's remaining share
quantity after a terminal partial exit. If it cannot confirm liquidation, it
attempts to restore a GTC stop, blocks new entries and queues a Telegram alert.
If an exit reports filled but shares remain unexpectedly, it requires
reconciliation rather than blindly selling again. Unknown/untracked holdings are
flagged for review instead of automatically liquidated.

Outside market hours, an exit is queued while existing stops remain in place;
a missing stop is restored when the broker accepts it. A seven-session holding
limit is audited independently of simulated historical TP/SL touches. New time
exits can be requested near the close starting at 15:35 ET. A working exit keeps
new entries blocked until a later audit confirms the position is flat. When
broker state cannot be read, the audit blocks entries and sends an alert.

**Stop restoration and Telegram delivery are best efforts, not guarantees.**
Broker rejection, outages, price gaps or unavailable reservations can still
leave risk. `/safety` and the dashboard show whether protection was confirmed.
Act on a protection alert in Alpaca promptly. Dry-run never submits or cancels
broker orders, including safety recovery orders.

New local defaults:

| Setting | Default |
|---|---:|
| Planned stop-distance risk per trade | 0.25% of equity |
| Concurrent holdings/pending entry symbols | 5 |
| Gross entry exposure | 100% of equity |
| Individual stock allocation | 20% of equity |
| Correlated group containing the new stock | 40% of equity |
| Positive return-correlation threshold | 0.70 |
| Minimum aligned historical return observations | 40 |

Gross exposure includes holdings and unfilled buy quantities. Broker order IDs
and the local journal prevent counting the same reservation twice. Existing
holdings are valued conservatively at the larger of market value and entry cost.
The individual percentage cap applies even if the old dollar cap is zero. Cash
and any positive dollar cap impose additional limits; margin buying power does
not increase these caps. A small execution buffer is reserved for pending market
orders. Actual market fills can still move beyond that buffer.

Correlation uses up to 60 aligned, completed daily returns, including holdings
and pending buys across different sectors. Missing history blocks the candidate.
The controls limit **new entries**; they do not automatically sell existing
positions merely because prices move them over a percentage cap. Explicit
values already saved in `data/config.json` are preserved: inspect `/config`.
For example, `/set riskPerTradePct 0.25` applies the new risk default to an older
explicit setting. Use `/set maxGrossExposurePct 100`, `/set maxPositionEquityPct
20`, or `/set maxCorrelatedExposurePct 40` to set those limits explicitly.
A gross percentage above 100 or an invalid limit blocks entries.

### Earnings and market-event review

Alpaca's price feed is **not an earnings calendar**. No automatic external
calendar has been added or assumed. The default event policy therefore requires
verified dates before a symbol can be entered. After updating, **symbols without
coverage are skipped**; the dashboard and `/safety` explain this.

Review the stock's upcoming **21 calendar days** in your broker or another
reliable calendar, then tell the bot in Telegram:

```text
/earnings AAPL 2026-11-05
/earnings MSFT none
```

Use `none` only after verifying no earnings in that reviewed period. A symbol
with earnings within 14 calendar days of entry is skipped. Coverage expires
after seven days or when it no longer covers the full forward window. Review
again at least weekly. These commands do not fetch or verify the source for you.
Do not mark every symbol `none` just to unblock trading.

You can maintain multiple symbols in ignored `data/events.json` instead:

```json
{
  "symbols": {
    "AAPL": {
      "checkedAt": "2026-10-18",
      "coveredThrough": "2026-11-08",
      "dates": ["2026-11-05"]
    }
  },
  "blockedDates": ["2026-10-28"]
}
```

Replace example dates with your actual review and calendar dates. `/eventblock
YYYY-MM-DD` blocks all new entries on a date you identify as a market event.
It does not close existing holdings or forecast events. Advanced users can
explicitly set `requireEventCoverage` to false in `data/config.json`; this disables
the coverage requirement and leaves unknown earnings unfiltered. Known dates
and explicit blocked dates still apply. The safe default is true.

### Update and verify

1. Send `/pause` to the local RSI2 bot.
2. In its active Git checkout, run `git pull --ff-only origin main`.
3. Run `.\Control-Swing.cmd Restart`, then `/healthcheck`, `/config`, `/safety`
   and `/positions` in Telegram. No image rebuild is needed for this source update.
4. Review explicit old risk settings and add valid earnings coverage for symbols
   you intend to trade. Resolve any untracked holdings or safety alerts.
5. Send `/resume` when ready. Resume cannot clear safety blocks or disable dry-run.

No test broker orders are needed. An update does not establish that the strategy
will become profitable; validate returns in paper trading after execution and
risk controls behave correctly.
