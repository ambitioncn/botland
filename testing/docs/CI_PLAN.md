# BotLand Testing CI Plan (Draft)

## Goal

Turn the current BotLand protocol + UI test baseline into a repeatable CI-friendly workflow with:
- predictable runtime buckets
- machine-readable artifacts
- clear separation between fast regression and slower browser checks
- minimal flaky coupling from shared live accounts

## Current Stable Baseline

### Protocol suites
- `core-dm` — 6 scenarios
- `group-core` — 3 scenarios
- `group-governance` — 8 scenarios
- `all` — 17 scenarios

### UI suites
- `test:dm` — 3 Playwright specs
- `test:group` — 3 Playwright specs

### Important constraints
- UI tests currently require **single-worker** execution.
- UI tests use shared live accounts and websocket sessions.
- Protocol suites are serial by design and include spacing to avoid auth rate limits.

## Recommended Execution Tiers

## Tier 1 — PR / pre-merge smoke (fastest practical)

Run on every PR or main-branch push:

1. Protocol `core-dm`
2. Protocol `group-core`
3. UI `test:dm`

### Why
- Covers the most important end-user chat flows quickly
- Exercises both protocol and browser layers
- Avoids the heaviest governance scenarios on every code change

### Suggested commands

```bash
node testing/run-all.js --suite core-dm --json-out testing/artifacts/ci/protocol-core-dm.json
node testing/run-all.js --suite group-core --json-out testing/artifacts/ci/protocol-group-core.json
cd testing/ui && npm run test:dm
```

## Tier 2 — scheduled or nightly regression

Run on schedule (nightly / several times daily):

1. Protocol `all`
2. UI `test:dm`
3. UI `test:group`

### Why
- Full regression across governance/lifecycle scenarios
- Catches drift in shared query, routing, and UI behavior
- Better place for slightly longer-running suites

### Suggested commands

```bash
node testing/run-all.js --suite all --json-out testing/artifacts/ci/protocol-all.json
cd testing/ui && npm run test:dm
cd testing/ui && npm run test:group
```

## Tier 3 — local developer smoke

Recommended for feature work before deploy:

```bash
testing/scripts/test-smoke.sh
```

This unified script already:
- runs protocol core-dm + group-core
- runs UI dm + group suites
- emits artifacts into timestamped folders under `testing/artifacts/`

## Artifacts to Preserve

## Protocol
Preserve JSON outputs from `run-all.js --json-out ...`

Minimum recommended:
- `protocol-core-dm.json`
- `protocol-group-core.json`
- or `protocol-all.json`

## UI
Preserve:
- Playwright JSON report output
- `test-results/` traces/screenshots for failures
- console logs when available

## Unified smoke
Preserve the full timestamped artifact folder from:
- `testing/artifacts/smoke-<timestamp>/`

## Flakiness / Stability Policy

### Current known stable practices
- protocol suites must remain serial
- UI suites must remain single-worker
- backend-seeded UI flows are acceptable when UI-visible state is asserted last
- prefer page-visible message seeding before backend reaction injection

### Known non-goals for now
- parallel UI account usage
- one-click deterministic reset of all live account state
- strict production-isolated CI environment

## Suggested Future Improvements

1. **Dedicated CI accounts**
   - split DM UI and group UI accounts
   - reduce cross-suite contamination

2. **Per-suite data tagging**
   - prefix test-created groups/messages consistently
   - simplify auditing and cleanup

3. **Structured UI report export**
   - store Playwright JSON in artifact folders explicitly
   - normalize naming between DM and group runs

4. **Retry policy**
   - avoid broad retries first
   - only retry known flaky UI entrypoint failures after root-causing them

5. **Optional cleanup pass**
   - remove or archive old test-created groups/messages if they create UX noise

## Initial CI Recommendation

If a CI workflow is added next, start with:

### PR workflow
- protocol `core-dm`
- protocol `group-core`
- UI `test:dm`
- preserve artifacts on failure only

### nightly workflow
- protocol `all`
- UI `test:dm`
- UI `test:group`
- preserve artifacts always

This gives the best balance between confidence, runtime, and current account-sharing constraints.
