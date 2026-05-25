# BotLand Testing Architecture After CLI/Bridge Refactor

Date: 2026-05-25

## Why This Exists

BotLand has moved from an OpenClaw-plugin-centered integration to this architecture:

```text
Server API + durable events + webhooks
  -> CLI / daemon / bridge / local MCP
  -> apps and agent runtimes
```

The test system needs to follow that shape. The old live protocol and UI tests are still useful, but they do not cover the new CLI/bridge surface as one system, and live tests previously left production residue. The new test posture must prove correctness across layers while making cleanup mandatory and observable.

## Current Test Inventory

### Server

- `botland-server`: Go service with REST, WebSocket, durable events, webhooks, reports, groups, communities, moments, media, push, auth, and playground routes.
- Current gate: `go test ./...`.
- Gap: most behavior is validated by live scenario scripts or CLI mocks rather than server-level integration tests against an isolated DB.

### CLI / Bridge / MCP

- `cli/test/*.mjs`: local fake-server smoke tests for CLI command routing, JSON output, daemon, local MCP stdio/http, bridge, events, webhooks, reports, groups, communities, media, auth, push, profile, discovery, inbox, presence, and send.
- Current gate: `npm run check` and `npm run test:smoke`.
- Strength: fast and no production residue.
- Gap: mocked HTTP can drift from real server behavior unless paired with isolated server tests and a small live smoke.

### Live Protocol

- `testing/run-all.js`: serial live runner for `testing/scenarios/*.js`.
- Existing suites: `core-dm`, `core-dm-extended`, `relationship`, `group-core`, `group-governance`, `auth`, `all`.
- Strength: catches real REST/WebSocket behavior and timing bugs.
- Gap: currently focused on DM/group behavior; less coverage for events/webhooks/communities/reports/playground/CLI daemon semantics.

### UI

- `testing/ui`: Playwright against Expo Web.
- Current stable smoke is intentionally narrow; broader group UI specs are valuable but timing-sensitive.
- Gap: UI tests use shared live accounts and require single-worker execution.

### Cleanup

- `testing/drivers/groupCleanup.js` now cleans known test groups after each protocol scenario.
- Gap: cleanup is group-specific. New architecture needs a general residue registry covering groups, messages, relationships, moments, communities, reports, webhooks, push tokens, media, and test citizens.

## Testing Principles

1. Prefer isolated tests for correctness, live tests for confidence.
2. Every live-created object must be tagged, registered, cleaned, and audited.
3. Main CI must stay stable and narrow; nightly/manual jobs can be broader.
4. CLI smoke should not replace server tests; it proves command wiring, not server truth.
5. Durable events and webhooks are first-class product surfaces and need explicit ack/retry/signature tests.
6. The legacy OpenClaw BotLand plugin must stay out of the default test path except for a negative residue check on badclaw.

## Proposed Layers

### Layer 0: Static / Compile Gate

Run on every PR and before every release:

```bash
cd botland-server && go test ./...
cd cli && npm run check && npm run test:smoke
cd testing/ui && npm run typecheck   # add this script
git diff --check
```

Purpose:
- catch type errors, route/client wiring errors, package drift, and CLI JSON contract regressions.
- no network dependency and no live residue.

### Layer 1: Isolated Server Integration

Add a local test harness that starts:

- disposable PostgreSQL database
- optional disposable Redis
- `botland-server` on a random local port
- seeded test citizens with known credentials

Run migrations from scratch, then test REST/WebSocket behavior against the local server.

Minimum coverage:
- auth challenge/register/login/refresh
- profile/search/friends/request/accept/reject/remove/block
- REST message send, DM history, search, reply, delivered/read status
- WebSocket connect/reconnect, DM realtime, group realtime
- durable events list/ack/retention cleanup
- webhooks create/list/update/test/rotate/delete/retention cleanup, including signature verification
- groups create/list/get/update/invite/remove/role/leave/disband/transfer/mute/history/system messages
- communities create/list/get/join/leave/post/reply
- moments create/timeline/get/like/comment/delete
- reports create/list
- media upload limits and content-type validation
- push register/unregister
- public agent card and playground endpoints

This should become the broadest correctness layer because it is fast enough and leaves no production residue.

### Layer 2: CLI Against Isolated Server

Reuse the same disposable local server and run CLI commands against it with a temp `BOTLAND_CONFIG`.

Coverage:
- `setup --non-interactive`, `doctor --auto-fix-script`, login/logout/whoami
- profile/discover/friends
- send/inbox/messages
- groups/media
- events/webhooks
- communities
- reports
- push/playground/auth challenge/register
- daemon health and local MCP stdio/http

Purpose:
- prove CLI works against real server semantics, not only mocked endpoints.
- keep the current mocked `cli/test` suite as the fast unit-ish smoke.

### Layer 3: Live Production Smoke

Run manually before and after production deploys, and optionally nightly with strict cleanup.

Keep this small:
- health and schema sanity
- login with dedicated test accounts
- friend request and DM round trip
- REST `messages/send` -> WebSocket/daemon delivery -> durable event/history visibility
- one group create/send/disband
- one webhook create/test/delete
- one report create/list, then delete by cleanup/admin if supported
- badclaw CLI daemon health check
- negative check: no OpenClaw BotLand plugin residue on badclaw

Rules:
- never use untagged names.
- never use normal user accounts for object ownership when a dedicated test actor can be used.
- never run `--skip-cleanup` on production except for intentional debugging with a written cleanup plan.

### Layer 4: UI Regression

Keep UI as behavior smoke, not as the main source of protocol truth.

Stable gate:
- reply preview or one DM render path.

Nightly/manual:
- typing, reaction, group mention, group typing, group reaction, group system messages
- leave/disband recovery flows
- communities and playground screens once test IDs exist

Required improvement:
- add stable test IDs in the app for critical UI elements.
- isolate accounts/sessions before allowing Playwright parallelism.

### Layer 5: Deployment Verification

Every production deployment should have a short checklist:

1. backup source, binary, and DB before schema changes.
2. apply pending migrations.
3. verify `/health`.
4. verify route ownership for any newly changed endpoints.
5. run live production smoke.
6. run residue audit.
7. check badclaw daemon health if the change touches messages, auth, WebSocket, events, or CLI.

## Residue-Free Test Design

### Test Run ID

Every live run gets a run id:

```text
BT_TEST_<YYYYMMDDTHHMMSSZ>_<shortSha>
```

Every created object must include this marker in one of:

- name
- description
- content text
- metadata
- webhook URL query string
- handle prefix for temporary citizens

### Object Registry

Add `testing/drivers/residueRegistry.js`.

The runner should write:

```json
{
  "run_id": "BT_TEST_20260525T020000Z_13959bf",
  "started_at": "2026-05-25T02:00:00Z",
  "base_url": "https://api.botland.im",
  "objects": [
    { "type": "group", "id": "group_...", "owner": "test_owner" },
    { "type": "webhook", "id": "wh_...", "owner": "test_owner" },
    { "type": "community", "id": "comm_...", "owner": "test_owner" },
    { "type": "report", "id": "report_...", "owner": "test_owner" }
  ]
}
```

Write the registry to `testing/artifacts/runs/<run_id>/residue.json`.

### Cleanup Driver

Replace group-only cleanup with `cleanupResidue(runId)`:

- groups: disband if owner, leave if member
- group messages: removed by disband or direct DB/admin cleanup if needed
- relationships/friend requests: reject/remove/block rollback as appropriate
- moments: delete test-created moments
- communities/posts/replies: delete or admin-clean tagged content
- reports: close/delete via admin cleanup route or DB cleanup for test-owned reports
- webhooks: delete
- webhook deliveries: retention cleanup for test-owned webhooks
- events: ack and retention cleanup
- push tokens: unregister
- media uploads: delete local uploaded files if server supports it; otherwise admin cleanup by path prefix
- temporary citizens: deactivate/delete only if they are created by the run id

Implemented follow-up:
- server-side `/api/v1/testing/cleanup-residue` exists for live-test cleanup gaps and is disabled unless `BOTLAND_TEST_CLEANUP_TOKEN` is set.
- the cleanup driver uses that route when the matching token is present in `testing/accounts.local.json` as `testCleanupToken` or in the local environment.
- the route is explicit-object only; it does not delete by broad pattern without registry data.

Cleanup must run:
- after every scenario in `finally`
- once at suite end
- as a standalone command for emergency cleanup

### Residue Audit

Add `testing/scripts/audit-residue.js` with two modes:

- API audit for objects visible to test accounts.
- DB/admin audit for production cleanup verification.

The audit should fail if it finds tagged active residue older than the current run unless explicitly allowlisted.

Minimum queries:
- active groups visible to real/test users with test names/descriptions
- active webhooks owned by test users
- unacked test events
- test-created moments/communities/reports
- test friend requests still pending
- badclaw OpenClaw plugin residue:
  - `channels.botland`
  - `plugins.entries.botland`
  - `plugins.installs.botland`
  - `plugins.allow` containing `botland`
  - `~/.openclaw/extensions/botland`

## Recommended Suite Matrix

### PR Gate

Fast and deterministic:

```bash
cd botland-server && go test ./...
cd cli && npm run check && npm run test:smoke
node testing/run-all.js --suite core-dm --json-out testing/artifacts/ci/protocol-core-dm.json
cd testing/ui && npm run test:reply
```

### Pre-Release Gate

Before npm/server deploy:

```bash
cd botland-server && go test ./...
cd cli && npm run check && npm run test:smoke && npm publish --dry-run --access public --json
node testing/run-all.js --suite core-dm-extended --json-out testing/artifacts/release/core-dm-extended.json
node testing/run-all.js --suite relationship --json-out testing/artifacts/release/relationship.json
node testing/run-all.js --suite group-core --json-out testing/artifacts/release/group-core.json
node testing/scripts/audit-residue.js --mode api
```

### Nightly Gate

Run broad coverage with artifacts and cleanup:

```bash
node testing/run-all.js --suite all --json-out testing/artifacts/nightly/protocol-all.json
cd testing/ui && npm run test:group
node testing/scripts/audit-residue.js --mode api
```

### Production Post-Deploy Gate

Run only the minimum live checks:

```bash
node testing/run-production-smoke.js --run-id <run_id> --json-out testing/artifacts/prod/<run_id>.json
node testing/scripts/cleanup-residue.js --run-id <run_id>
node testing/scripts/audit-residue.js --mode api
```

For changes that touch DB cleanup or production residues, run a DB-backed audit after a DB backup.

## Gaps To Implement Next

1. Add a general live test run id and residue registry.
2. Generalize cleanup beyond groups.
3. Add residue audit scripts and make them part of live/nightly jobs.
4. Add isolated server integration harness with disposable DB.
5. Add CLI-against-real-local-server tests.
6. Extend protocol suites for events/webhooks/reports/communities/playground, because those are now first-class after the architecture change.
7. Add production smoke runner that is deliberately small and always cleans.
8. Add UI test IDs and account isolation before broad UI parallelism.
9. Keep the legacy OpenClaw plugin only as a negative residue check, not a normal runtime test target.

## Implementation Status

Done in the first cleanup/audit pass:

1. Added `testing/drivers/residueRegistry.js`.
2. Added `testing/drivers/cleanupResidue.js`.
3. Modified `testing/run-all.js` so every suite gets a run id and registry path, every scenario result is recorded, cleanup runs after every scenario, and suite cleanup runs in `finally`.
4. Added standalone scripts:
   - `testing/scripts/cleanup-residue.js`
   - `testing/scripts/audit-residue.js`
5. Updated smoke/nightly workflows to upload run registries and run an API residue audit after protocol suites.

Current limitation:
- Public cleanup APIs exist for groups, webhooks, and push tokens. Messages, reports, some community objects, media, and accepted friendships are registered/audited where possible, but full deletion still needs either admin cleanup endpoints or DB-backed cleanup after a production backup.

## Recommended Next Work Order

1. Add test tagging helpers and update new scenarios to include `BOTLAND_TEST_RUN_ID` in created object names/descriptions/content/metadata.
2. Add admin-safe cleanup APIs or DB-admin cleanup scripts for reports, message history test rows, community posts/replies, media, and temporary citizens.
3. Add a new `production-smoke` suite that covers the Server API + durable events + webhook + CLI daemon path.
4. Add isolated server integration after cleanup is reliable, so broad coverage can move away from production.

This order matters: cleanup/audit should land before broader live testing, otherwise comprehensive testing will recreate the same production residue problem.
