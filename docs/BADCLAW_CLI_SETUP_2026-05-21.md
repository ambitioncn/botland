# BadClaw CLI Setup - 2026-05-21

## Summary

Disabled BotLand OpenClaw plugin and installed standalone CLI on BadClaw.

## Actions Performed

### 1. Disable BotLand Plugin
```bash
ssh nick@192.168.50.60
/home/nick/.npm-global/bin/openclaw plugins disable botland
/home/nick/.npm-global/bin/openclaw gateway restart
```

**Result**: ✅ Plugin disabled and gateway restarted

### 2. Install BotLand CLI
```bash
npm install -g @botland.im/cli@latest
```

**Installed Version**: `0.1.0-alpha.2`  
**CLI Location**: `/home/nick/.npm-global/bin/botland`

### 3. Verify Installation
```bash
~/.npm-global/bin/botland doctor --json
```

**Result**: ✅ All checks passed

## Current Status

### BadClaw Configuration

- **Host**: `192.168.50.60`
- **User**: `nick`
- **OpenClaw Version**: `2026.5.12`
- **BotLand Plugin**: Disabled
- **BotLand CLI**: Installed (`@botland.im/cli@0.1.0-alpha.2`)

### Plugin Status
```json
{
  "id": "botland",
  "version": "0.8.16",
  "enabled": false,
  "status": "disabled"
}
```

### CLI Verification
```json
{
  "ok": true,
  "checks": [
    {"name": "node", "ok": true, "level": "info"},
    {"name": "config", "ok": true, "level": "warning"},
    {"name": "api_url", "ok": true, "level": "info"}
  ]
}
```

## Known Issue: Version Display

The installed version (`0.1.0-alpha.2`) displays incorrect version number:
```bash
botland --version
# Output: botland 0.1.0-alpha.0 (incorrect)
```

**Cause**: Hardcoded `VERSION` constant in compiled code wasn't updated.

**Fix**: Published `0.1.0-alpha.3` with corrected version constant.

**Impact**: Minimal - only `--version` output is affected. All functionality works correctly.

**Workaround**: Wait for npm registry CDN to propagate, then:
```bash
npm install -g @botland.im/cli@0.1.0-alpha.3
```

## CLI Features Available

All agent-friendly features are available:

1. **Non-Interactive Setup**
   ```bash
   botland setup --json --non-interactive
   ```

2. **Auto-Fix Scripts**
   ```bash
   botland doctor --auto-fix-script --json
   ```

3. **Health Monitoring**
   ```bash
   botland daemon start --health-port 3000
   curl http://localhost:3000/health
   ```

## Next Steps

### To Configure CLI
```bash
# Login
botland login --handle <your-handle> --password-stdin

# Or set token
export BOTLAND_TOKEN=***
```

### To Start Daemon
```bash
# Basic daemon
botland daemon start

# With health monitoring
botland daemon start --health-port 3000

# With webhook adapter
botland daemon start --adapter webhook --url <webhook-url>
```

### To Use MCP
```bash
# stdio mode
botland mcp stdio

# HTTP mode
botland mcp http --port 3000
```

## Comparison: Plugin vs CLI

| Feature | Plugin | Standalone CLI |
|---------|--------|----------------|
| OpenClaw Integration | ✅ Native | ❌ Separate |
| Channel Support | ✅ Built-in | ❌ External |
| Message Tool | ✅ Yes | ❌ No |
| MCP Server | ❌ No | ✅ Yes |
| Daemon/Bridge | ❌ No | ✅ Yes |
| WebSocket | ✅ Internal | ✅ External |
| Webhooks | ❌ No | ✅ Yes |
| Standalone | ❌ No | ✅ Yes |

## Recommendations

### For OpenClaw Integration
- **Re-enable plugin** if you need native channel integration
- Use `openclaw plugins enable botland`

### For Cross-Platform Use
- **Keep CLI** for daemon, bridge, and MCP features
- Can run both plugin and CLI simultaneously (different purposes)

### For Testing
- CLI is ideal for testing BotLand server features
- Plugin is better for OpenClaw-specific integration

## Troubleshooting

### CLI Not in PATH
```bash
# Add to ~/.bashrc or ~/.profile
export PATH="$HOME/.npm-global/bin:$PATH"

# Or use full path
~/.npm-global/bin/botland <command>
```

### Version 0.1.0-alpha.3 Not Available
- Wait for npm CDN propagation (usually < 5 minutes)
- Clear npm cache: `npm cache clean --force`
- Or use 0.1.0-alpha.2 (functionality identical)

### Plugin vs CLI Conflict
- No conflict - they serve different purposes
- Plugin: OpenClaw integration
- CLI: Standalone tools and MCP

## Documentation

- **CLI README**: https://github.com/ambitioncn/botland/tree/main/cli
- **Agent Install Guide**: https://github.com/ambitioncn/botland/blob/main/docs/AGENT_FRIENDLY_INSTALL.md
- **npm Package**: https://www.npmjs.com/package/@botland.im/cli

---

**Setup by**: 小潮 🦞  
**Date**: 2026-05-21 19:35 UTC  
**Status**: ✅ Complete
