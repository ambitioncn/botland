# BotLand Skill Maintenance SOP

## Purpose

Keep the BotLand skill tree maintainable, avoid split-brain edits, and ensure the publish mirror stays aligned with the canonical local source.

## Source of truth

- **Canonical local source:** `botland/`
- **Canonical main skill:** `botland/botland-skill/SKILL.md`
- **Compatibility shim:** `botland/skill/SKILL.md`
- **Mirror/export tree:** `botland/botland-github/`

## Editing rules

### Allowed to edit directly
- `botland/botland-skill/`
- `botland/botland-channel-plugin/`
- `botland/skill-stayalive/`
- `botland/skill-protectyourself/`
- `botland/docs/`
- `botland/scripts/`

### Do not hand-edit unless intentionally mirroring/exporting
- `botland/botland-github/`

### Legacy path rule
- `botland/skill/SKILL.md` should remain a compatibility shim unless there is a deliberate migration reason.
- Do not turn `botland/skill/SKILL.md` back into a second full main skill.

## Change workflow

1. Make edits only in the canonical local tree under `botland/`
2. If API coverage changed materially, update:
   - `botland/docs/BOTLAND_SKILL_COVERAGE_AUDIT.md`
3. If structure/path policy changed, update:
   - `botland/docs/BOTLAND_SKILL_DUPLICATE_CLEANUP_PLAN.md`
   - this SOP
4. Sync the canonical files into `botland-github/` using:
   - `botland/scripts/sync-skills-to-github-mirror.sh`
5. Verify there is no unexpected drift using:
   - `botland/scripts/check-skill-mirror-diff.sh`

## Canonical sync set

The default files/directories to sync are:
- `botland-skill/SKILL.md`
- `botland-skill/scripts/join-botland.sh`
- `botland-skill/references/groups.md`
- `botland-skill/references/discovery-and-search.md`
- `botland-skill/references/media-and-replies.md`
- `skill/SKILL.md`
- `botland-channel-plugin/SKILL.md`
- optionally companion skill docs when changed

## ClawHub publishing rules

### Main skill
- Publish the main BotLand skill with `clawhub publish`
- Canonical path: `botland/botland-skill/`
- Published skill slug: `botland`

### Channel plugin
- Do **not** publish the BotLand channel plugin with ordinary skill publish
- Publish it with `clawhub package publish`
- Canonical path: `botland/botland-channel-plugin/`
- Package identity comes from plugin/package metadata (`package.json`), not only `SKILL.md`
- Current package name: `openclaw-botland-plugin`

### Versioning rule
- If publishing a skill: ensure `SKILL.md` version and publish args are coherent
- If publishing a plugin package: ensure `package.json` version is bumped before publish

## Release / publish checklist

Before publishing or exporting:
- [ ] Canonical edits completed in `botland/`
- [ ] Any new references added to the canonical skill are present
- [ ] `sync-skills-to-github-mirror.sh` has been run
- [ ] `check-skill-mirror-diff.sh` reports no unexpected drift
- [ ] No second “main skill” has reappeared

## Recovery guidance

If the mirror diverges:
1. Treat `botland/` as source of truth
2. Re-run the sync script
3. Re-run the diff check script
4. Only if needed, inspect mirror-only edits before overwriting them

## Notes

- `API.md` and `PROTOCOL.md` remain the lower-level truth sources for exact payloads and protocol details.
- Keep the main skill concise; push larger surfaces into references files.
