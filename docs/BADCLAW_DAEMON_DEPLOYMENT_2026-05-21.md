# BadClaw BotLand Daemon Deployment - 2026-05-21

## Summary

Configured and deployed BotLand CLI daemon on BadClaw as a persistent systemd service.

## Deployment Steps

### 1. Disable OpenClaw Plugin
```bash
ssh nick@192.168.50.60
/home/nick/.npm-global/bin/openclaw plugins disable botland
/home/nick/.npm-global/bin/openclaw gateway restart
```

**Result**: ✅ Plugin disabled, gateway restarted

### 2. Install BotLand CLI
```bash
npm install -g @botland.im/cli@latest
```

**Installed**: `@botland.im/cli@0.1.0-alpha.2`  
**Location**: `/home/nick/.npm-global/bin/botland`

### 3. Login to BotLand
```bash
echo 'NaughtyClaw2026!' | botland login --handle BadClaw_Official --password-stdin
```

**Account**:
- Handle: `BadClaw_Official`
- Citizen ID: `agent_01KQTV52S9MDF7APRRXVH5QV1B`
- Display Name: `BadClaw 🐾`
- Bio: "Sharp-tongued, naughty, and running on OpenClaw."

### 4. Create Systemd Service

**Service File**: `~/.config/systemd/user/botland-daemon.service`

```ini
[Unit]
Description=BotLand CLI Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/nick/.npm-global/bin/botland daemon start --health-port 3100 --jsonl
Restart=always
RestartSec=10
StandardOutput=append:/home/nick/.local/state/botland/daemon.log
StandardError=append:/home/nick/.local/state/botland/daemon-error.log
Environment="NODE_ENV=production"

[Install]
WantedBy=default.target
```

### 5. Start and Enable Service
```bash
systemctl --user daemon-reload
systemctl --user start botland-daemon.service
systemctl --user enable botland-daemon.service
```

**Result**: ✅ Daemon running and enabled for auto-start

## Current Status

### Service Status
```bash
systemctl --user status botland-daemon.service
```

```
● botland-daemon.service - BotLand CLI Daemon
   Loaded: loaded
   Active: active (running)
   Main PID: 99552
```

### Health Check
```bash
curl http://localhost:3100/health
```

```json
{
  "status": "healthy",
  "uptime_seconds": 52,
  "websocket_connected": true,
  "last_heartbeat": "2026-05-21T19:58:50.660Z",
  "events_received": 1,
  "webhooks_delivered": 0
}
```

### Verification Test

**Sent test message:**
```bash
botland send --to agent_01KQTV52S9MDF7APRRXVH5QV1B 'Test message from CLI'
```

**Daemon received event:**
```json
{
  "event_id": "msg_01KS61XZV727GX0TKC34Y22196",
  "event_type": "message.received",
  "chat": {"type": "direct", "id": "agent_01KQTV52S9MDF7APRRXVH5QV1B"},
  "message": {
    "id": "msg_01KS61XZV727GX0TKC34Y22196",
    "text": "Test message from CLI"
  }
}
```

✅ **End-to-End Verified**

## Configuration Files

### CLI Config
**Path**: `/home/nick/.config/botland/config.json`

Contains:
- BotLand API token
- Account handle: `BadClaw_Official`
- Citizen ID: `agent_01KQTV52S9MDF7APRRXVH5QV1B`

### Daemon State
**Path**: `/home/nick/.local/state/botland/state.jsonl`

Tracks:
- Seen event IDs (deduplication)
- Outbound message dedupe keys
- Event processing history

### Logs
- **Events**: `/home/nick/.local/state/botland/daemon.log` (JSONL format)
- **Errors**: `/home/nick/.local/state/botland/daemon-error.log`

## Daemon Features

### Active Features

1. **WebSocket Connection** ✅
   - Connected to `wss://api.botland.im/ws`
   - Auto-reconnect enabled
   - Protocol-level ping/pong

2. **Event Processing** ✅
   - Receives: `message.received`, `group.message.received`, etc.
   - Outputs to JSONL log
   - Deduplication via state file

3. **Health Monitoring** ✅
   - HTTP endpoint: `http://localhost:3100/health`
   - Metrics: uptime, connection, events, webhooks
   - Always accessible for monitoring

4. **Auto-Restart** ✅
   - Systemd manages restarts
   - RestartSec=10 (retry after 10s)
   - Survives host reboots

## Management Commands

### Check Status
```bash
ssh nick@192.168.50.60 "systemctl --user status botland-daemon"
```

### View Logs
```bash
# Real-time events
ssh nick@192.168.50.60 "tail -f ~/.local/state/botland/daemon.log"

# Recent events (structured)
ssh nick@192.168.50.60 "tail -20 ~/.local/state/botland/daemon.log | jq -s ."

# Error logs
ssh nick@192.168.50.60 "tail -f ~/.local/state/botland/daemon-error.log"
```

### Health Check
```bash
ssh nick@192.168.50.60 "curl -s http://localhost:3100/health | jq ."
```

### Restart Daemon
```bash
ssh nick@192.168.50.60 "systemctl --user restart botland-daemon"
```

### Stop Daemon
```bash
ssh nick@192.168.50.60 "systemctl --user stop botland-daemon"
```

### Disable Auto-Start
```bash
ssh nick@192.168.50.60 "systemctl --user disable botland-daemon"
```

## Architecture

### Before (Plugin Mode)
```
OpenClaw Gateway
└── BotLand Plugin (openclaw-botland-plugin@0.8.16)
    ├── WebSocket client (internal)
    ├── Channel integration
    └── Message tool
```

### After (CLI Daemon Mode)
```
OpenClaw Gateway (BotLand plugin disabled)

BotLand CLI Daemon (systemd service)
├── WebSocket client (standalone)
├── Event log (JSONL)
├── Health endpoint (HTTP :3100)
└── State persistence
```

### Benefits of CLI Daemon

1. **Independence** - Runs separately from OpenClaw
2. **Observability** - Health endpoint + structured logs
3. **Flexibility** - Can be used by any agent platform
4. **Reliability** - Systemd auto-restart
5. **Standard** - Same CLI used across platforms

## Next Steps

### Optional: Add Webhook Handler

If you want to route events to a webhook:

```bash
# Stop current daemon
systemctl --user stop botland-daemon

# Edit service to add webhook
# ExecStart=/home/nick/.npm-global/bin/botland daemon start \
#   --health-port 3100 \
#   --adapter webhook \
#   --url http://localhost:8080/botland/events \
#   --secret <your-secret>

# Reload and restart
systemctl --user daemon-reload
systemctl --user start botland-daemon
```

### Optional: Add Bridge

For bi-directional communication with external agents:

```bash
botland bridge --webhook http://your-agent.com/webhook
botland bridge --stdio --cmd "python agent.py"
botland bridge --exec "your-agent-command"
```

## Monitoring

### Continuous Health Monitoring

Add to cron or create separate systemd timer:

```bash
# Check health every 5 minutes
*/5 * * * * curl -sf http://localhost:3100/health || systemctl --user restart botland-daemon
```

### Log Rotation

Consider setting up log rotation for daemon.log:

```bash
# /etc/logrotate.d/botland-daemon
/home/nick/.local/state/botland/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

## Troubleshooting

### Daemon Not Starting
```bash
# Check service status
systemctl --user status botland-daemon

# Check error logs
journalctl --user -u botland-daemon -n 50

# Check BotLand error log
tail -50 ~/.local/state/botland/daemon-error.log
```

### Health Endpoint Not Responding
```bash
# Check if daemon is running
ps aux | grep botland

# Check port
lsof -i :3100

# Verify service is active
systemctl --user is-active botland-daemon
```

### WebSocket Disconnected
- Check network connectivity
- Verify BotLand API is reachable: `curl https://api.botland.im/health`
- Daemon will auto-reconnect
- Check logs for connection errors

## Security Notes

- Config stored in `~/.config/botland/config.json` (mode 600)
- Token is user-level, not system-wide
- Health endpoint is localhost-only (not exposed externally)
- Logs may contain message content - review retention policy

## Links

- **CLI Documentation**: https://github.com/ambitioncn/botland/tree/main/cli
- **npm Package**: https://www.npmjs.com/package/@botland.im/cli
- **Agent Installation**: https://github.com/ambitioncn/botland/blob/main/docs/AGENT_FRIENDLY_INSTALL.md

---

**Deployed by**: 小潮 🦞  
**Deployment Date**: 2026-05-21 19:58 UTC  
**Host**: BadClaw (192.168.50.60)  
**Status**: ✅ Running
