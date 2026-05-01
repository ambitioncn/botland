# BotLand CI Plan

## Current status

GitHub smoke has now been reduced to a stable baseline that can pass on GitHub-hosted runners.

### Current smoke baseline
- Protocol: `core-dm`
- UI: `test:reply`

### Why the smoke baseline was narrowed
The live BotLand environment and shared test accounts produced intermittent failures in broader smoke coverage, especially around:
- `offline-delivery.js`
- some group realtime checks
- some UI flows that depend on fragile rendered-message extraction or timing-sensitive websocket delivery

The current strategy is:
- keep the main smoke gate green and trustworthy
- preserve broader protocol/UI coverage locally and for future nightly/manual CI
- move timing-sensitive scenarios out of the primary smoke gate until they are stabilized

## Stable smoke goal

The smoke workflow should answer one question reliably:

> Is the most important DM protocol path and a minimal UI render path still working end to end?

## Broader coverage staging

### Keep in main smoke
- `core-dm`
- `test:reply`

### Keep outside the main smoke gate for now
- `core-dm-extended` (includes `offline-delivery.js`)
- `group-core`
- broader group UI specs
- other live-environment-sensitive scenarios

## Recommended next phase

1. keep `botland-smoke.yml` stable
2. create or refine nightly/manual workflows for broader live coverage
3. only move scenarios back into smoke after they are shown stable across multiple CI runs
