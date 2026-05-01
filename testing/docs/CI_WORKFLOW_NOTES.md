# BotLand GitHub Actions Workflow Notes

This note explains the intended usage and prerequisites for:

- `.github/workflows/botland-smoke.yml`

## Purpose

The current workflow is a **draft CI entrypoint** for BotLand smoke coverage.
It is meant to formalize the commands and artifact strategy that are already stable locally.

## What the workflow currently runs

### Job: `protocol-core`
- `core-dm`
- `group-core`

Artifacts:
- `testing/artifacts/ci/*.json`

### Job: `ui-dm`
- `testing/ui` Playwright DM suite (`npm run test:dm`)

Artifacts:
- `testing/ui/test-results`
- `testing/ui/playwright-report`

## Why it is intentionally conservative

The workflow currently does **not** run:
- `group-governance`
- `test:group`
- full `all` protocol suite

Reason:
- shared live test accounts
- websocket/session coupling
- runtime budget
- desire to start CI with the most stable core slices first

## Prerequisites / assumptions

## 1. Live test environment availability
The tests assume BotLand backend/websocket environment is reachable from CI.

Examples of current dependencies:
- `https://api.botland.im`
- `wss://api.botland.im/ws`

If CI runners cannot reach that environment reliably, these jobs will be noisy.

## 2. Test account configuration
The local test system expects stable shared accounts defined in account config.

Before enabling CI broadly, confirm:
- test accounts exist and remain provisioned
- credentials are injected safely
- account reuse across jobs is acceptable

If account config should not live in repo, move it behind CI secrets or generated files.

## 3. Dependency installation shape
The workflow currently assumes:
- root-level Node install via `npm ci`
- separate UI install under `testing/ui`

If package layout changes, update:
- `cache-dependency-path`
- install steps
- working directories

## 4. UI test execution model
UI suites must remain:
- single-worker
- serial enough to avoid shared-session interference

Do not remove this constraint until test isolation improves.

## Recommended next hardening steps

1. Add explicit repository/environment secrets documentation
2. Decide whether CI should run on GitHub-hosted or self-hosted runners
3. Confirm whether Expo Web startup is already handled or needs explicit workflow steps
4. Add a dedicated nightly workflow for:
   - protocol `all`
   - UI `test:group`
5. Consider dedicated CI-only test accounts

## Suggested enablement path

### Stage 1
- keep workflow as draft
- validate syntax
- dry-run in a branch

### Stage 2
- enable `protocol-core`
- confirm JSON artifact upload

### Stage 3
- enable `ui-dm`
- verify browser provisioning and result artifacts

### Stage 4
- add nightly workflow with broader suites

## Operational note

If CI becomes flaky, do not immediately add retries everywhere.
First identify whether the source is:
- environment reachability
- account contention
- websocket/session coupling
- browser startup/runtime timing

The current local baseline is strong enough that most remaining instability should be treated as infrastructure or isolation work, not hidden with blanket retries.
