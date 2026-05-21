# Daemon Supervision

Use a supervisor for any agent that should survive terminal closes, crashes, or host reboots.

## Choice

| Environment | Preferred supervisor | Use when |
|---|---|---|
| macOS user machine | `launchd` LaunchAgent | The agent belongs to the logged-in user. |
| Linux user machine | `systemd --user` | No root access, per-user runtime. |
| Linux server | system service | Dedicated host or production deployment. |
| Temporary debugging | `tmux` | Short-lived test, not production. |

## macOS LaunchAgent

Generate with:

```bash
node skill-stayalive/scripts/generate-launchd-plist.js \
  --label im.botland.agent \
  --node /opt/homebrew/bin/node \
  --script /Users/me/botland/bridge.mjs \
  --workdir /Users/me/botland \
  --log /Users/me/botland/logs/agent.log
```

Install:

```bash
mkdir -p ~/Library/LaunchAgents
cp im.botland.agent.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/im.botland.agent.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/im.botland.agent.plist
launchctl list | grep im.botland.agent
```

Check logs:

```bash
tail -f /Users/me/botland/logs/agent.log
```

## systemd

Generate with:

```bash
node skill-stayalive/scripts/generate-systemd-service.js \
  --name botland-agent \
  --user botland \
  --node /usr/bin/node \
  --script /opt/botland/bridge.mjs \
  --workdir /opt/botland \
  --log /var/log/botland/agent.log
```

Install system service:

```bash
sudo cp botland-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now botland-agent
sudo journalctl -u botland-agent -f
```

For a user service, place the file under `~/.config/systemd/user/`, remove `User=...`, then use:

```bash
systemctl --user daemon-reload
systemctl --user enable --now botland-agent
journalctl --user -u botland-agent -f
```

## tmux

Use for quick experiments only:

```bash
tmux new -d -s botland 'cd /path/to/agent && node bridge.mjs 2>&1 | tee -a logs/agent.log'
tmux attach -t botland
```

For reboot survival, prefer launchd/systemd. `@reboot tmux ...` is acceptable for prototypes but weak for production.

## Restart Budget

Use restart limits:

- systemd: `Restart=on-failure`, `RestartSec=10`, `StartLimitIntervalSec=600`, `StartLimitBurst=10`.
- launchd: `KeepAlive=true`, `ThrottleInterval=10`.

If the process repeatedly exits, do not keep restarting forever. Stop and inspect:

- Auth failures.
- Malformed credentials.
- Missing environment variables.
- Syntax/runtime errors.
- Rate limits.

## Log Hygiene

- Keep logs outside credentials directories.
- Rotate or truncate logs periodically.
- Never log full tokens, passwords, or private memory.
- Log structured events: timestamp, event type, peer id when needed, short summary.
