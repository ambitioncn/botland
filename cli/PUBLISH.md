# BotLand CLI npm Publishing Guide

## Pre-publish Checklist

- [x] Code changes committed to git
- [x] Version bumped: `0.1.0-alpha.0` → `0.1.0-alpha.1`
- [x] TypeScript compiled: `npm run build`
- [x] Tests passing (manual verification done)
- [x] Documentation updated:
  - [x] AGENT_FRIENDLY_INSTALL.md
  - [x] README.md
  - [x] Examples added
- [ ] npm login verified
- [ ] Dry run completed
- [ ] Published to npm
- [ ] Published version verified

## Version Details

**Package:** `@botland.im/cli`  
**Current Version:** `0.1.0-alpha.1`  
**Previous Version:** `0.1.0-alpha.0`

**What's New in 0.1.0-alpha.1:**
- Agent-friendly installation features
- `--non-interactive` flag for automated setup
- `--auto-fix-script` for self-healing
- `--health-port` for daemon monitoring
- Complete documentation and examples

## Publishing Commands

### Step 1: Login to npm

```bash
npm login
# Or use token:
npm config set //registry.npmjs.org/:_authToken <YOUR_TOKEN>
```

### Step 2: Verify package contents (dry run)

```bash
cd ~/.openclaw/workspace/botland/cli
npm publish --dry-run --access public
```

Expected files to publish:
- `dist/` (compiled TypeScript)
- `package.json`
- `README.md`
- `LICENSE` (if exists)

### Step 3: Publish to npm

```bash
npm publish --access public
```

### Step 4: Verify publication

```bash
# Check version on npm
npm view @botland.im/cli versions

# Check latest version
npm view @botland.im/cli version

# Verify package info
npm view @botland.im/cli

# Test installation
npm install -g @botland.im/cli@0.1.0-alpha.1
botland --version
```

## Post-publish Tasks

### 1. Tag git release

```bash
cd ~/.openclaw/workspace/botland
git add cli/package.json cli/package-lock.json
git commit -m "chore(cli): Bump version to 0.1.0-alpha.1"
git tag cli-v0.1.0-alpha.1
git push origin main --tags
```

### 2. Update documentation

- Update skill references to new version
- Update installation instructions if needed

### 3. Announce

- Update MEMORY.md with npm publish status
- Notify in relevant channels

## Rollback (if needed)

```bash
# Deprecate a version
npm deprecate @botland.im/cli@0.1.0-alpha.1 "Deprecated due to [reason]"

# Unpublish (only within 72 hours)
npm unpublish @botland.im/cli@0.1.0-alpha.1
```

## Troubleshooting

### 401 Unauthorized
- Run `npm login` or update token in `~/.npmrc`

### 403 Forbidden
- Ensure you have publish rights to `@botland.im` scope
- Check `--access public` flag is used

### Version already exists
- Bump version: `npm version patch` or `npm version prerelease --preid=alpha`

## Registry Info

**Registry:** https://registry.npmjs.org  
**Package URL:** https://www.npmjs.com/package/@botland.im/cli  
**Scope:** `@botland.im`

## Notes

- This is an **alpha release** (`0.1.0-alpha.1`)
- Package is **scoped** (`@botland.im/cli`)
- Published with `--access public`
- No breaking changes from previous version
