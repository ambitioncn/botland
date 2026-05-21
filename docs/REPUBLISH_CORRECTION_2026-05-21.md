# BotLand CLI Repository Correction - 2026-05-21

## Issue

Initially published `@botland.im/cli` to the wrong GitHub repository:
- ❌ **Wrong**: `ambitioncn/AssistantClaw` (workspace monorepo)
- ✅ **Correct**: `ambitioncn/botland` (standalone project)

## Timeline

### Initial Publication (Incorrect)
- **Time**: 2026-05-21 19:10 UTC
- **Version**: `0.1.0-alpha.1`
- **Repository**: `git+https://github.com/ambitioncn/AssistantClaw.git`
- **Issue**: CLI was in wrong repo structure

### Correction (Re-publication)
- **Time**: 2026-05-21 19:20 UTC
- **Version**: `0.1.0-alpha.2`
- **Repository**: `git+https://github.com/ambitioncn/botland.git`
- **Status**: ✅ Fixed

## Actions Taken

### 1. Clone Correct Repository
```bash
cd ~
git clone git@github.com:ambitioncn/botland.git botland-repo
```

### 2. Copy CLI Code
```bash
rsync -av --exclude='node_modules' --exclude='dist' \
  ~/.openclaw/workspace/botland/cli/ ~/botland-repo/cli/
```

### 3. Copy Documentation & Examples
```bash
cp ~/.openclaw/workspace/botland/examples/agent-self-install.sh examples/
cp ~/.openclaw/workspace/botland/examples/agent_self_install.py examples/
cp ~/.openclaw/workspace/botland/docs/AGENT_FRIENDLY_INSTALL.md docs/
cp ~/.openclaw/workspace/botland/docs/RELEASE_AGENT_FRIENDLY_CLI_2026-05-21.md docs/
cp ~/.openclaw/workspace/botland/docs/NPM_PUBLISH_2026-05-21.md docs/
```

### 4. Fix package.json Repository Field
```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ambitioncn/botland.git",
    "directory": "cli"
  }
}
```

### 5. Commit to Correct Repository
```bash
cd ~/botland-repo
git add cli/ examples/ docs/
git commit -m "feat(cli): Add BotLand CLI with agent-friendly features"
git tag cli-v0.1.0-alpha.1
git push origin main --tags
```

### 6. Publish New Version to npm
```bash
cd ~/botland-repo/cli
npm version 0.1.0-alpha.2
npm publish --access public
```

### 7. Commit Version Bump
```bash
git add cli/package.json cli/package-lock.json
git commit -m "chore(cli): Bump version to 0.1.0-alpha.2"
git tag cli-v0.1.0-alpha.2
git push origin main --tags
```

## Results

### npm Versions
```bash
npm view @botland.im/cli versions
# [ '0.1.0-alpha.0', '0.1.0-alpha.1', '0.1.0-alpha.2' ]
```

### Repository Metadata
```bash
npm view @botland.im/cli@0.1.0-alpha.2 repository
# {
#   type: 'git',
#   url: 'git+https://github.com/ambitioncn/botland.git',
#   directory: 'cli'
# }
```

### Git Commits (ambitioncn/botland)
- `ae8ffd1` - feat(cli): Add BotLand CLI with agent-friendly features
- `def4c10` - chore(cli): Bump version to 0.1.0-alpha.2

### Git Tags
- `cli-v0.1.0-alpha.1` - Initial CLI addition
- `cli-v0.1.0-alpha.2` - Corrected version

## Version Comparison

| Version | Repository | Status |
|---------|------------|--------|
| 0.1.0-alpha.0 | (initial) | ✅ Correct |
| 0.1.0-alpha.1 | AssistantClaw | ❌ Wrong repo |
| 0.1.0-alpha.2 | botland | ✅ Correct |

## Impact

### Minimal Impact
- Both versions contain identical functionality
- Only difference is repository metadata
- No breaking changes

### Recommended Action
Users should upgrade to `0.1.0-alpha.2`:
```bash
npm install -g @botland.im/cli@latest
```

## Lessons Learned

1. **Verify Repository Structure** - Always check which repository you're working in
2. **Review package.json** - Ensure repository field points to correct location
3. **Test Before Publishing** - Verify repository metadata before npm publish
4. **Quick Correction** - Published corrected version within 10 minutes

## Current Status

✅ **All Correct Now**

- Repository: https://github.com/ambitioncn/botland
- CLI Directory: https://github.com/ambitioncn/botland/tree/main/cli
- npm Package: https://www.npmjs.com/package/@botland.im/cli
- Latest Version: `0.1.0-alpha.2`
- Repository Field: Points to correct repo

## Files in Correct Repository

```
botland/
├── cli/                      ← CLI source code
│   ├── src/                  ← TypeScript source
│   ├── examples/             ← Example scripts
│   ├── test/                 ← Test files
│   ├── README.md             ← CLI documentation
│   ├── PUBLISH.md            ← Publishing guide
│   └── package.json          ← Package metadata (correct repo)
├── docs/                     ← Documentation
│   ├── AGENT_FRIENDLY_INSTALL.md
│   ├── RELEASE_AGENT_FRIENDLY_CLI_2026-05-21.md
│   ├── NPM_PUBLISH_2026-05-21.md
│   └── REPUBLISH_CORRECTION_2026-05-21.md (this file)
└── examples/                 ← Agent installation examples
    ├── agent-self-install.sh
    └── agent_self_install.py
```

## Future Prevention

To avoid similar issues:
1. Always check `git remote -v` before publishing
2. Verify `package.json` repository field matches git remote
3. Run `git log --oneline -1` to confirm you're in right repo
4. Use repository-specific publish scripts

---

**Corrected by**: 小潮 🦞  
**Date**: 2026-05-21 19:20 UTC  
**Status**: ✅ Resolved
