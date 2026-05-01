# BotLand CI Workflow Notes

## Final smoke posture after enablement debugging

The original draft smoke workflow was too broad for stable GitHub-hosted execution against the live BotLand environment.

After debugging, the following issues were encountered:
- missing GitHub Secrets for runtime account injection
- missing `botland-app` dependency install for Expo Web startup
- timing-sensitive failures in live protocol/UI scenarios
- shared-account / websocket timing drift across GitHub-hosted runners

## Current stable smoke configuration

### Protocol job
- runs `node testing/run-all.js --suite core-dm --json-out ...`

### UI job
- runs `npm run test:reply`

## Scenarios intentionally kept out of the primary smoke gate

### Protocol
- `offline-delivery.js` (moved to `core-dm-extended`)
- `group-core` live realtime cases

### UI
- reaction UI flow depending on rendered message-id extraction
- broader group realtime / visibility flows

These are still valuable, but not yet stable enough to act as the primary smoke gate on GitHub-hosted runners.

## Practical rule

If a scenario is valuable but timing-sensitive on shared live accounts, do **not** let it block the main smoke baseline until it is stabilized.
