# BotLand ClawHub Publish Record — 2026-05-04

## Published artifacts

### Skill
- `botland@0.9.1`
- Type: Agent skill
- Path: `botland/botland-skill/`

### Plugin package
- `openclaw-botland-plugin@0.8.4`
- Display name: `BotLand Channel Plugin`
- Type: ClawHub package / code plugin
- Path: `botland/botland-channel-plugin/`

## What mattered

- Main BotLand usage should point people to the **skill**: `botland`
- OpenClaw channel integration should point people to the **plugin package**: `openclaw-botland-plugin`

## Errors encountered and resolved

### 1. Plugin published with the wrong interface
Attempting to publish the BotLand channel plugin with ordinary skill publish failed:

- Error: `This looks like a plugin. Use "clawhub package publish <source>" instead.`

Resolution:
- Use `clawhub package publish`, not `clawhub publish`, for plugin/package folders.

### 2. Package name mismatch
Attempting to publish with `--name botland-channel-plugin` failed:

- Error: `ClawPack package name mismatch: expected botland-channel-plugin, got openclaw-botland-plugin`

Resolution:
- For plugin packages, trust the package manifest (`package.json`) package name.
- Actual package name: `openclaw-botland-plugin`

### 3. Package version mismatch
Attempting to publish `0.8.4` before bumping the manifest failed:

- Error: `ClawPack package version mismatch: expected 0.8.4, got 0.8.3`

Resolution:
- For plugin packages, version must be updated in `package.json`, not only in `SKILL.md`.

## Commands used

### Main skill
```bash
clawhub publish /home/nickn/.openclaw/workspace/botland/botland-skill \
  --slug botland \
  --name "BotLand Agent Skill" \
  --version 0.9.1 \
  --changelog "Consolidate canonical main skill, improve API coverage docs, add references for groups/search/media/replies, clarify ordinary BotLand usage vs OpenClaw channel plugin integration."
```

### Plugin package
```bash
clawhub package publish /home/nickn/.openclaw/workspace/botland/botland-channel-plugin \
  --family code-plugin \
  --name openclaw-botland-plugin \
  --display-name "BotLand Channel Plugin" \
  --version 0.8.4 \
  --changelog "Bump plugin package to 0.8.4, avoid skill-name collision with the main BotLand skill, and clarify channel integration positioning."
```

## Rule of thumb

- **Skill publish path** → `clawhub publish` → version/name driven by `SKILL.md` and publish args
- **Plugin/package publish path** → `clawhub package publish` → version/name driven by `package.json` / plugin package metadata
