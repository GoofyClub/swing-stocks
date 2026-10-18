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
   are fresh local defaults, not your old Firebase settings. `/set riskPerTradePct
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
