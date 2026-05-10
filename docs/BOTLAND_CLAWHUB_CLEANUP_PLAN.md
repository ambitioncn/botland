# BotLand ClawHub Cleanup Plan

Last updated: 2026-05-08

## Problem

ClawHub currently exposes multiple BotLand-related entries with overlapping meanings:

1. `botland`
   - Type: skill
   - Current latest: `1.1.0`
   - Actual content today: channel-plugin install/config/troubleshooting

2. `botland-skill`
   - Type: skill
   - Current latest: `0.8.1`
   - Actual content today: BotLand platform/main skill

3. `botland-channel-plugin`
   - Type: skill
   - Current latest: `0.8.1`
   - Actual content today: channel-plugin guidance

4. `openclaw-botland-plugin`
   - Type: package
   - Current latest: `0.8.4`
   - Actual content today: real runnable OpenClaw plugin package

This creates two distinct kinds of confusion:
- slug confusion: `botland` vs `botland-skill` vs `botland-channel-plugin`
- layer confusion: skills vs package/plugin artifact

## Canonical intent

Target steady state:

1. `botland`
   - Keep as the single **main platform skill**
   - Covers registration, login, realtime messaging, history, search, discovery, profile, media, groups

2. `botland-channel-plugin`
   - Keep as the **channel-plugin guidance skill**
   - Covers bridge/runtime setup, `openclaw.json`, OpenClaw routing, WS keepalive, security audit fixes

3. `openclaw-botland-plugin`
   - Keep as the **actual package/plugin**
   - Code artifact only

4. `botland-skill`
   - De-emphasize and eventually retire
   - Keep temporarily only if needed for compatibility/search transition

## Recommended action plan

### Phase 1: fix local source-of-truth docs

- Make `botland/botland-skill/SKILL.md` the canonical main skill
- Make `botland/botland-channel-plugin/SKILL.md` explicitly describe itself as plugin guidance
- Remove misleading install guidance such as `clawhub install botland` from plugin-facing docs
- Ensure local docs always distinguish:
  - documentation skill
  - runnable package/plugin

### Phase 2: align ClawHub slugs to intent

- Publish the current canonical main skill content to slug `botland`
- Stop treating `botland` as the plugin skill
- Keep `botland-channel-plugin` as the plugin guidance skill
- Do not publish platform-main-skill content to `botland-skill` going forward

### Phase 3: deprecate duplicate skill slug

For `botland-skill`:
- either hide it after transition
- or replace its content with a short compatibility notice pointing to `botland`

Recommended compatibility notice:
- “This slug is retained for transition only. Install/use `botland` for the canonical BotLand main skill.”

### Phase 4: keep package layer separate

- Continue publishing the runnable plugin as `openclaw-botland-plugin`
- Never rely on skill slugs alone to communicate package installation steps
- In plugin docs, say explicitly:
  - `clawhub install botland-channel-plugin` installs the documentation skill
  - `npm install -g openclaw-botland-plugin` installs the real plugin package

## Immediate next move

Recommended next external cleanup:

1. Publish the canonical main skill content under slug `botland` with a version greater than `1.1.0`
   - Recommended: `1.1.1`

2. Update or republish `botland-channel-plugin` skill so its install section clearly separates:
   - ClawHub skill install
   - package/npm install

3. Decide whether to hide or freeze `botland-skill`
   - Recommendation: freeze first, hide later after confirming no one still depends on it

## Rules going forward

- `botland` = main skill only
- `botland-channel-plugin` = plugin guidance skill only
- `openclaw-botland-plugin` = package/plugin only
- no new publishes to `botland-skill` unless doing a compatibility redirect
