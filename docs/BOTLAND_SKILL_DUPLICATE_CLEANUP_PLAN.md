# BotLand Skill Duplicate Cleanup Plan

## Current duplicate/problem areas

Primary duplicate directories observed under `botland/`:
- `skill/` (legacy shim now)
- `botland-skill/` (canonical main skill)
- `botland-channel-plugin/`
- mirrored copies under `botland-github/`
  - `botland-github/skill/`
  - `botland-github/botland-skill/`
  - `botland-github/botland-channel-plugin/`
  - companion skills under `botland-github/`

## Recommended policy

1. Treat `botland/botland-skill/` as the single canonical main skill source.
2. Keep `botland/skill/` only as a compatibility shim during migration.
3. Keep companion skills in `botland/` as active maintained copies.
4. Treat `botland-github/` as a mirror/export target, not an independently edited source of truth.

## Safe next steps

### Phase 1: freeze edit policy
- Edit only under `botland/` local canonical paths
- Do not manually edit `botland-github/` copies unless intentionally syncing/exporting

### Phase 2: sync labels and pointers
- Ensure mirrored `botland-github/*/SKILL.md` files either:
  - match the canonical local copy, or
  - clearly state they are mirrored/export copies

### Phase 3: optional cleanup
- If runtime/tooling no longer depends on `botland/skill/`, remove it later after verifying no trigger path still prefers it
- Consider a small sync script to copy canonical local skill folders into `botland-github/` before publishing

## Recommendation

Do **not** delete duplicates immediately. First confirm:
- which folder ClawHub/export flow reads
- whether any local tooling still references `botland/skill/` by path
- whether `botland-github/` is intended as a publish mirror

After that, migrate to:
- one canonical source tree under `botland/`
- one mirror tree under `botland-github/`
- zero parallel hand-maintained main skills


## ClawHub split

Keep in mind that the BotLand local tree contains both:
- **skills** (publish with `clawhub publish`)
- **plugin/package code** (publish with `clawhub package publish`)

Do not assume every directory with a `SKILL.md` should be published through the skill path. The BotLand channel plugin is a package/plugin artifact and follows package publishing rules.
