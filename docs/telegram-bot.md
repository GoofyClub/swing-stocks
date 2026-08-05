# Telegram control bot

A long-running process on the VM that answers commands over Telegram, so the
system can be monitored and controlled from a phone without SSH.

```
MONITOR   /health  /status  /positions  /pnl  /log [n]  /errors
CONTROL   /pause  /resume  /flatten  /exclude [add|remove|list]
          /set <field> <value>  /config  /deploy
```

## Security — read this before enabling it

This process can **liquidate positions and change risk settings**, so it is only
as safe as its allow-list.

- `TELEGRAM_ALLOWED_CHAT_IDS` is **mandatory**. The bot *refuses to start*
  without it rather than defaulting to open — a control bot anyone can find and
  message is strictly worse than no bot.
- Unauthorized chats get **no reply at all**, not even an error, since an error
  would confirm the bot exists.
- `/flatten` and `/deploy` require an explicit `CONFIRM` argument, so a mistap
  cannot liquidate the account.
- `/config` masks every secret, so a pasted transcript can't leak a broker key.
- `/set` accepts **numeric risk fields only**. Strategy / tier / index selection
  stays in the UI: those are multi-value, easy to corrupt from a chat line, and a
  corrupt allow-list silently stops *all* trading — that exact bug once cost days
  of no entries.

## Setup

**1. Create the bot** — message [@BotFather](https://t.me/BotFather), send
`/newbot`, and keep the token.

**2. Find your chat id** — message your new bot once, then:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'
```

**3. Add to `~/swing-config/swing.env`:**

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-your-token
TELEGRAM_ALLOWED_CHAT_IDS=987654321      # comma-separate for several
REPO_DIR=/home/srinathrn89/swing-stocks  # enables /deploy; omit to disable it
```

**4. Test in the foreground first:**

```bash
cd ~/swing-stocks
set -a && . ~/swing-config/swing.env && set +a
npm run bot
```

Send `/health` from Telegram. Then `Ctrl+C` and install the service.

## Service (auto-restart)

Unlike the trading runners this is a **persistent** service, so it uses
`Restart=always` rather than a timer.

`/etc/systemd/system/swing-bot.service`:

```ini
[Unit]
Description=Swing Telegram control bot
After=network-online.target

[Service]
Type=simple
User=srinathrn89
WorkingDirectory=/home/srinathrn89/swing-stocks
EnvironmentFile=/home/srinathrn89/swing-config/swing.env
ExecStart=/usr/bin/node scripts/telegram-bot.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now swing-bot
systemctl status swing-bot
journalctl -u swing-bot -f
```

## Commands

| Command | What it does |
|---|---|
| `/health` | Bot uptime, pause state, broker reachability, market open/closed, last 3 runs. |
| `/status` | Automation state, equity, buying power, open vs max positions, active filters. |
| `/positions` | Open positions with unrealized P&L. |
| `/pnl` | Today's P&L plus realized totals and W/L record from the order journal. |
| `/log [n]` | Last worker run's log (default 20 lines, max 60). |
| `/errors` | Failed runs from the last 25, with the error text. |
| `/pause` | Sets `publicConfig/automation.paused` — **every** worker honours it. Positions and brackets are untouched. |
| `/resume` | Clears the pause. |
| `/flatten CONFIRM` | Closes all positions at market and cancels their orders. Without `CONFIRM` it previews what would be closed. |
| `/exclude add\|remove\|list TICKER` | Never-auto-trade list. |
| `/set <field> <value>` | Numeric risk/sizing fields only; lists the allowed set when called bare. |
| `/config` | Effective runtime config, secrets masked. |
| `/deploy CONFIRM` | `git pull --ff-only && npm ci` in `REPO_DIR`. Disabled unless `REPO_DIR` is set. |

## Notes

- `/pause` is the same switch the `KILL_SWITCH` env var trips, but **persistent** —
  it survives restarts and applies to every worker until `/resume`.
- `/deploy` updates the code the *scheduled runners* will use on their next fire.
  The bot itself keeps running its old code until
  `sudo systemctl restart swing-bot`.
- With more than one automation-enabled user, set `TELEGRAM_ADMIN_UID`. The bot
  refuses to guess rather than risk acting on the wrong account.
