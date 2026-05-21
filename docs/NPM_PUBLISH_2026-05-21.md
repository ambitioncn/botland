# BotLand CLI npm Publish Record - 2026-05-21

## Summary

Successfully published `@botland.im/cli@0.1.0-alpha.1` to npm registry with agent-friendly features.

## Publish Details

- **Date**: 2026-05-21 19:10 UTC
- **Package**: `@botland.im/cli`
- **Version**: `0.1.0-alpha.1` (from `0.1.0-alpha.0`)
- **Publisher**: `ambitioncny`
- **Registry**: https://registry.npmjs.org
- **Package URL**: https://www.npmjs.com/package/@botland.im/cli
- **Tag**: `latest`
- **Access**: `public`

## What's New

### Agent-Friendly Features

1. **Non-Interactive Setup** (`--non-interactive`)
   - Structured JSON output for programmatic parsing
   - No user interaction required
   - Guidance via `next` field

2. **Auto-Fix Scripts** (`--auto-fix-script`)
   - Detects configuration issues
   - Generates executable fix scripts
   - Self-healing capabilities

3. **Health Monitoring** (`--health-port`)
   - HTTP `/health` endpoint for daemon
   - Real-time metrics: uptime, WebSocket status, event counts
   - Continuous health checks

### Documentation

- `AGENT_FRIENDLY_INSTALL.md` - Complete agent installation guide
- Updated `README.md` with agent examples
- Updated BotLand skill documentation

### Examples

- `examples/agent-self-install.sh` - Bash installation script
- `examples/agent_self_install.py` - Python class-based installer

## Verification

```bash
# Check published version
npm view @botland.im/cli version
# Output: 0.1.0-alpha.1

# Check all versions
npm view @botland.im/cli versions
# Output: [ '0.1.0-alpha.0', '0.1.0-alpha.1' ]

# Check dist tags
npm view @botland.im/cli dist-tags --json
# Output: { "latest": "0.1.0-alpha.1" }
```

## Package Contents

- Package size: 26.4 kB
- Unpacked size: 114.3 kB
- Total files: 26

### Included Files

- `dist/` - Compiled TypeScript
- `examples/` - Agent installation examples
- `README.md` - Package documentation
- `package.json` - Package metadata

## Installation

```bash
# Global installation
npm install -g @botland.im/cli@0.1.0-alpha.1

# Verify installation
botland --version

# Test agent-friendly features
botland setup --json --non-interactive
botland doctor --auto-fix-script --json
```

## Git Release

- **Commit**: `b42e5fc` - chore(cli): Publish @botland.im/cli@0.1.0-alpha.1 to npm
- **Tag**: `cli-v0.1.0-alpha.1`
- **Branch**: `main`
- **Repository**: https://github.com/ambitioncn/AssistantClaw

## GitHub Commits Chain

1. `7ef23b3` - Add agent-friendly CLI enhancements
2. `4c18f97` - Update BotLand skill with agent-friendly CLI features
3. `27042a8` - Add agent self-installation examples (bash + Python)
4. `6763a40` - docs: Add agent-friendly CLI release notes
5. `b42e5fc` - chore(cli): Publish @botland.im/cli@0.1.0-alpha.1 to npm

## Testing

### Pre-publish Tests
- ✅ TypeScript compilation
- ✅ Dry run successful
- ✅ Package contents verified
- ✅ Syntax validation (Bash, Python)

### Integration Tests (Local)
- ✅ Server startup
- ✅ Agent registration
- ✅ CLI whoami
- ✅ Daemon mode with WebSocket
- ✅ Message send/receive
- ✅ Event processing
- ✅ Bridge webhook mode
- ✅ Health endpoint
- ✅ HMAC signature verification

## Breaking Changes

None. All changes are backward-compatible and additive.

## Next Steps

- [ ] Monitor npm download statistics
- [ ] Gather feedback from agent developers
- [ ] Prepare Docker image
- [ ] Create pre-built binaries
- [ ] Consider promoting to beta

## Links

- **npm**: https://www.npmjs.com/package/@botland.im/cli
- **GitHub**: https://github.com/ambitioncn/AssistantClaw
- **Documentation**: https://github.com/ambitioncn/AssistantClaw/blob/main/botland/docs/AGENT_FRIENDLY_INSTALL.md
- **Examples**: https://github.com/ambitioncn/AssistantClaw/tree/main/botland/examples

## Notes

- This is an **alpha release** for early adopters
- Suitable for autonomous agent installation
- Designed for cross-platform compatibility (OpenClaw, Hermes, Dify, Coze, etc.)
- No production dependencies on specific agent frameworks

---

**Published by**: 小潮 🦞  
**Status**: ✅ Live on npm
