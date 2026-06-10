# BotLand Skill Maintenance SOP

## Purpose

Keep the BotLand skill tree maintainable, avoid split-brain edits, and ensure the publish mirror stays aligned with the canonical local source.

## Source of truth

- **Canonical local source:** `/home/nickn/botland-repo`
- **Canonical main skill:** `/home/nickn/botland-repo/botland-skill/SKILL.md`
- **Compatibility shim:** `/home/nickn/botland-repo/skill/SKILL.md`
- **Legacy mirror/export tree:** `botland-github/`, only when working from the old workspace mirror flow

## Editing rules

### Allowed to edit directly
- `botland-skill/`
- `botland-channel-plugin/`
- `skill-stayalive/`, if present
- `skill-protectyourself/`, if present
- `docs/`
- `scripts/`

### Do not hand-edit unless intentionally mirroring/exporting
- `botland-github/`, if present in a legacy checkout

### Legacy path rule
- `skill/SKILL.md` should remain a compatibility shim unless there is a deliberate migration reason.
- Do not turn `skill/SKILL.md` back into a second full main skill.

## Change workflow

1. Make edits only in the canonical local tree under `/home/nickn/botland-repo`
2. If API coverage changed materially, update:
   - `docs/BOTLAND_SKILL_COVERAGE_AUDIT.md`
3. If structure/path policy changed, update:
   - `docs/BOTLAND_SKILL_DUPLICATE_CLEANUP_PLAN.md`
   - this SOP
4. If a `botland-github/` mirror exists, sync the canonical files into it using:
   - `scripts/sync-skills-to-github-mirror.sh`
5. Verify there is no unexpected drift, or that canonical files are present when no mirror exists, using:
   - `scripts/check-skill-mirror-diff.sh`

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
- Canonical path: `botland-skill/`
- Published skill slug: `botland`

### Channel plugin
- Do **not** publish the BotLand channel plugin with ordinary skill publish
- Publish it with `clawhub package publish`
- Canonical path: `botland-channel-plugin/`
- Package identity comes from plugin/package metadata (`package.json`), not only `SKILL.md`
- Current package name: `openclaw-botland-plugin`

### Versioning rule
- If publishing a skill: ensure `SKILL.md` version and publish args are coherent
- If publishing a plugin package: ensure `package.json` version is bumped before publish

## Release / publish checklist

Before publishing or exporting:
- [ ] Canonical edits completed in `/home/nickn/botland-repo`
- [ ] Any new references added to the canonical skill are present
- [ ] `sync-skills-to-github-mirror.sh` has been run when a legacy mirror exists, or reports no mirror/no-op in the current canonical repo
- [ ] `check-skill-mirror-diff.sh` reports no unexpected drift, or canonical file presence is ok in the current canonical repo
- [ ] No second “main skill” has reappeared

## Recovery guidance

If the mirror diverges:
1. Treat `/home/nickn/botland-repo` as source of truth
2. Re-run the sync script
3. Re-run the diff check script
4. Only if needed, inspect mirror-only edits before overwriting them

## Notes

- `API.md` and `PROTOCOL.md` remain the lower-level truth sources for exact payloads and protocol details.
- Keep the main skill concise; push larger surfaces into references files.
