# Logging and the dashboard

## One file

Every process on the VM appends to the same file:

```
~/swing-stocks/logs/swing.log
```

Written by the same-day runner, the morning worker, the Telegram bot, and
`deploy.sh`. Each line carries a UTC timestamp and the writer's tag, so the
sequence reads in order across processes:

```
2026-08-09T19:38:02.114Z [sameday] scanned 64 candidate signal(s) in 214s
2026-08-09T19:38:04.220Z [sameday] skip AMD: re-entry cooldown: stopped out 1.2d ago (3d cooldown)
2026-08-09T19:38:07.902Z [sameday] PLACED buy 12 ARWR @ market (order 6f2c…)
2026-08-09T19:40:11.006Z [sameday] EXIT MSFT: native (model win @ 421.30) — position closed
2026-08-09T19:41:15.330Z [bot    ] /status from 12345
```

This exists because the alternative was three `journalctl` invocations against
three units and interleaving them by eye. journald still has its copy — the file
is in addition to it, not instead.

Rotation is in-process: at 32 MB (`SWING_LOG_MAX_BYTES`) the file becomes
`swing.log.1` and a fresh one starts. One generation is kept — trading logs are
for forensics over days, and an unbounded archive on a small VM disk is its own
outage.

Reading it:

```bash
tail -f logs/swing.log                    # live
grep PLACED logs/swing.log | tail -20     # today's entries
grep -E 'ERROR|WARN' logs/swing.log       # problems
```

From Telegram: `/log 40`, or `/log 40 PLACED` to filter.

## The dashboard

`scripts/dashboard.mjs` serves the same log over HTTP with syntax colouring, a
regex filter, and cards for the timer, service state, and today's counts.

```
http://<vm>:8444/           dashboard
http://<vm>:8444/log        raw text (curl-friendly: /log?n=500&grep=EXIT)
http://<vm>:8444/healthz    liveness, no auth
```

### Why not port 8443

It cannot share the ORB dashboard's port. One listening socket belongs to one
process; a second `bind()` to the same address and port fails with
`EADDRINUSE`. Default here is **8444**. To serve both from one address, put a
reverse proxy (nginx/Caddy) in front and route by path — the hostname can be
shared, the port cannot.

### Security

It serves your positions and order flow, so it **refuses to start** without
`DASHBOARD_USER` and `DASHBOARD_PASSWORD_HASH` — the same stance the Telegram
bot takes on its chat allow-list.

- Credentials compared in constant time; failures lock the source IP out for
  `DASHBOARD_LOCKOUT_SEC` after `DASHBOARD_MAX_FAILS` attempts.
- Known secret values and secret-shaped strings (Telegram tokens, Alpaca key
  ids, service-account private keys) are stripped from anything served.
- It speaks **plain HTTP**. Basic-auth credentials cross the network in base64,
  so `DASHBOARD_BIND=127.0.0.1` plus an SSH tunnel is the recommended setup:

  ```bash
  # ON YOUR LAPTOP, not on the VM — from the VM this just dials itself and
  # fails with "Permission denied (publickey)".
  gcloud compute ssh YOUR_INSTANCE --zone=YOUR_ZONE -- -L 8444:localhost:8444
  ```
  Then browse to http://localhost:8444.

  Use `0.0.0.0` only behind a firewall rule that restricts the source IP.

Generate the hash:

```bash
read -rs PW && printf '%s' "$PW" | sha256sum && unset PW
```

### Install

```bash
./scripts/setup-vm.sh --units
sudo systemctl enable --now swing-dashboard
```

## Deploying

`scripts/deploy.sh` is the one procedure, whether run from a shell or from
Telegram's `/deploy`.

```bash
./scripts/deploy.sh            # pull, install, verify, restart what changed
./scripts/deploy.sh --check    # report only, change nothing
./scripts/deploy.sh --force    # restart even with no changes / inside the window
```

What it guarantees, and why each one is there:

| Rule | Reason |
|---|---|
| Fast-forward only | A merge commit created unattended on a trading box is code nobody has read. |
| Tests run **before** any restart | A box that fails to start at 15:38 doesn't trade. On a red suite the old code keeps running. |
| Refuses inside 15:30–16:05 ET | Restarting mid-run kills an in-flight order pass. |
| Restarts only what changed | A docs-only deploy shouldn't bounce a live process. |
| Bot restart is detached | Triggered from `/deploy`, the script is a *child* of `swing-bot.service`; restarting it directly would kill the deploy mid-flight. The restart is handed to a transient `systemd-run` unit outside the cgroup. |
| Refuses on a dirty working tree | Local edits on the VM are either wanted or a mistake; either way, silently discarding them is wrong. |

The same-day runner is a `oneshot` fired by a timer — there is no daemon to
restart. New code applies from its next firing.
