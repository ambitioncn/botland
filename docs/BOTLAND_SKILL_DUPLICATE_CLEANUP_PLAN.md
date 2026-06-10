# BotLand Skill Duplicate Cleanup Plan

## Current duplicate/problem areas

Primary duplicate directories observed in the current repo:
- `skill/` (legacy shim now)
- `botland-skill/` (canonical main skill)
- `botland-channel-plugin/`
- legacy mirrored copies under `botland-github/`, only if working from the old workspace mirror flow
  - `botland-github/skill/`
  - `botland-github/botland-skill/`
  - `botland-github/botland-channel-plugin/`
  - companion skills under `botland-github/`

## Recommended policy

1. Treat `/home/nickn/botland-repo/botland-skill/` as the single canonical main skill source.
2. Keep `/home/nickn/botland-repo/skill/` only as a compatibility shim during migration.
3. Keep companion skills in `/home/nickn/botland-repo/` as active maintained copies when present.
4. Treat `botland-github/` as a legacy mirror/export target only when it exists, not an independently edited source of truth.

## Safe next steps

### Phase 1: freeze edit policy
- Edit only under `/home/nickn/botland-repo` canonical paths
- Do not manually edit `botland-github/` copies unless intentionally working with a legacy mirror/export

### Phase 2: sync labels and pointers
- If a legacy mirror exists, ensure mirrored `botland-github/*/SKILL.md` files either:
  - match the canonical local copy, or
  - clearly state they are mirrored/export copies

### Phase 3: optional cleanup
- If runtime/tooling no longer depends on `skill/`, remove it later after verifying no trigger path still prefers it
- Keep the sync scripts safe in both modes: no-op/presence-check in the canonical repo, real copy/diff only when a mirror directory exists

## Recommendation

Do **not** delete duplicates immediately. First confirm:
- which folder ClawHub/export flow reads
- whether any local tooling still references `botland/skill/` by path
- whether `botland-github/` is intentionally being used in a legacy checkout

After that, migrate to:
- one canonical source tree under `/home/nickn/botland-repo`
- zero required mirror trees in the current GitHub-connected repo
- zero parallel hand-maintained main skills


## ClawHub split

Keep in mind that the BotLand local tree contains both:
- **skills** (publish with `clawhub publish`)
- **plugin/package code** (publish with `clawhub package publish`)

Do not assume every directory with a `SKILL.md` should be published through the skill path. The BotLand channel plugin is a package/plugin artifact and follows package publishing rules.
