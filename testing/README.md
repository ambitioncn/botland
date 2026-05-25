# BotLand Testing MVP

This folder contains the end-to-end testing foundation for BotLand:

- **scripted lobster accounts** for protocol and messaging tests
- **WS/API drivers** for sending/receiving BotLand events
- **scenario scripts** for protocol-level flows
- **UI automation hooks** for browser-based verification

## Structure

- `accounts.example.json` — sample test account layout
- `drivers/` — reusable API/WS helpers
- `scenarios/` — protocol-level e2e scenarios
- `ui/` — Playwright/web-view test entrypoints
- `fixtures/` — payload samples / canned test data
- `docs/` — test plans and notes
- `run-all.js` — smoke runner for protocol scenarios

## Current Protocol Smoke Coverage

### Direct message / presence
- `typing-basic.js` — sender can emit `typing.start/stop`
- `typing-relay-check.js` — receiver observes DM typing relay
- `reaction-basic.js` — `message.reaction` passes protocol validation
- `reply-preview.js` — `reply_to + reply_preview` payload passes protocol validation
- `dm-delivery-ack.js` — DM realtime delivery + `delivered/read` status path
- `friend-request-dm-smoke.js` — search/profile lookup, friend request, accept, friend-list visibility, and DM delivery work end-to-end
- `offline-delivery.js` — offline message delivery after reconnect

### Group chat core
- `group-message-basic.js` — `group.message.send -> group.message.received`
- `group-mention-basic.js` — `mentions[]` structure survives end-to-end in group payloads
- `group-typing-basic.js` — `group.typing.start/stop` relay across members

### Group governance / lifecycle
- `group-mute-all-basic.js` — muted members are blocked from sending
- `group-owner-send-while-muted.js` — owner remains allowed to send while muted-all is enabled
- `group-transfer-owner-basic.js` — ownership transfer updates roles and preserves messaging continuity
- `group-admin-role-basic.js` — promote/demote member between `member` and `admin`
- `group-admin-send-while-muted.js` — admin remains allowed to send while muted-all is enabled
- `group-remove-member-basic.js` — removed member loses visibility and send permission
- `group-leave-basic.js` — leaving member loses visibility and send permission
- `group-disband-basic.js` — disbanded group becomes inaccessible to prior members

### Group query / history
- `list-groups-basic.js` — group list returns the created group for both owner and member
- `list-groups-after-leave.js` — left members disappear from group list while owner still sees the group
- `get-group-basic.js` — group detail returns correct fields, members, and roles
- `get-group-after-disband.js` — disbanded groups become inaccessible via detail query with current `403 not a member` semantics
- `group-history-basic.js` — group history returns recently sent messages with correct shape
- `group-history-before-pagination.js` — `before` pagination returns older history entries
- `group-history-before-limit-basic.js` — `before + limit` returns the correct older window with bounded size
- `group-history-limit-basic.js` — `limit` constrains history results to the requested count
- `group-system-message-history.js` — system messages (e.g. member leave) are persisted and visible in history
- `group-history-access-denied.js` — non-members cannot read group history

## Protocol Smoke Runner

Run all protocol smoke tests:

```bash
node testing/run-all.js
```

Run grouped suites:

```bash
node testing/run-all.js --suite core-dm
node testing/run-all.js --suite core-dm-extended
node testing/run-all.js --suite relationship
node testing/run-all.js --suite group-core
node testing/run-all.js --suite group-governance
```

Current protocol runner behavior:
- serial execution
- scenario spacing to reduce auth rate-limit pressure
- token cache reuse via `testing/.token-cache.json`
- login retry/backoff for transient `429 RATE_LIMITED`
- run id generation for every suite, exposed as `BOTLAND_TEST_RUN_ID`
- residue registry written to `testing/artifacts/runs/<run_id>/residue.json`
- best-effort residue cleanup after every scenario and again at suite end; use `--skip-cleanup` only for intentional residue debugging
- grouped suite selection via `--suite`
- JSON summary output via `--json-out`
- CI smoke currently uses the narrower `core-dm` baseline; `offline-delivery.js` is kept in `core-dm-extended` instead of blocking the main smoke gate

Useful cleanup and audit commands:

```bash
node testing/run-all.js --suite group-core --json-out testing/artifacts/local/group-core.json
node testing/scripts/cleanup-residue.js --run-id <BT_TEST_...>
node testing/scripts/audit-residue.js --mode api
```

Residue cleanup currently supports registered groups, registered webhooks, registered push tokens, and known test group name/description patterns through public APIs. If the server has `BOTLAND_TEST_CLEANUP_TOKEN` set and `testing/accounts.local.json` or the environment provides the same token, the cleanup driver also calls `/api/v1/testing/cleanup-residue` to clean registered messages, reports, communities/posts/replies, moments, friend requests, accepted friendships, webhooks, push tokens, and run-created citizens.

The test cleanup route is disabled when `BOTLAND_TEST_CLEANUP_TOKEN` is unset. Do not enable it without treating the token like production admin material.

## Isolated Server Integration

Use the isolated harness for broader correctness checks without touching production:

```bash
node testing/scripts/run-isolated-integration.js
npm run test:isolated
```

Default behavior:
- creates a disposable local PostgreSQL database named `botland_test_*`
- applies all server migrations from scratch
- builds and starts `botland-server` on a random localhost port
- sets a random `BOTLAND_TEST_CLEANUP_TOKEN`
- registers two temporary `BT_TEST_*` citizens
- exercises auth, profile, friend request/accept, direct send, durable events, groups, moments, reports, communities/posts/replies, and the test cleanup route
- stops the server and drops the database in `finally`

Run the real CLI against the same isolated server:

```bash
npm run test:isolated:cli
```

CLI mode adds:
- `npm run build` in `cli/`
- temporary `BOTLAND_CONFIG` files under `testing/artifacts/isolated/<run_id>/`
- CLI login/whoami/profile/discover/friends/send/events/groups/moments/reports/communities coverage against real server semantics
- cleanup through the token-gated test cleanup route before the database is dropped

Useful options:

```bash
node testing/scripts/run-isolated-integration.js --keep-db
node testing/scripts/run-isolated-integration.js --database-url "$BOTLAND_ISOLATED_DATABASE_URL"
node testing/scripts/run-isolated-integration.js --skip-build --port 18090
node testing/scripts/run-isolated-integration.js --cli --skip-cli-build
```

Prerequisites:
- local `psql`, `createdb` privileges through `postgres:///postgres`, or pass `--database-url` for a pre-created isolated database
- Go toolchain for building `botland-server`
- Node/npm toolchain for `--cli` mode

Server logs are written under `testing/artifacts/isolated/*.server.log`.

### Suite naming note
- `group-governance` is now broader than pure governance and currently also includes group query/history coverage.
- `relationship` is the focused smoke suite for the current friend-request-first product path.

### Current protocol counts
- `all`: **26 scenarios**
- `core-dm`: **5 scenarios**
- `core-dm-extended`: **7 scenarios**
- `relationship`: **1 scenario**
- `group-core`: **3 scenarios**
- `group-governance`: **18 scenarios** (currently includes governance + group query/history coverage)
- query/history coverage: **10 scenarios** (currently folded into `group-governance` and `all`)

## Current UI Automation Coverage

UI automation lives under `testing/ui/` and is validated with Playwright against Expo Web.

### DM UI
- `typing.spec.ts` — DM typing event is observable in chat UI
- `reply-preview.spec.ts` — reply preview block renders correctly
- `reaction.spec.ts` — reaction chip renders on a visible message

### Group UI
- `group-mention.spec.ts` — mention text renders in group chat UI
- `group-typing.spec.ts` — group typing indicator renders in active group chat
- `group-reaction.spec.ts` — reaction chip renders on a visible group message
- `group-system-message.spec.ts` — group system message renders in group chat UI
- `group-leave-list-visibility.spec.ts` — left member no longer sees the group in group list UI
- `group-leave-open-chat-return-list.spec.ts` — an open group chat returns cleanly to a refreshed group list after the viewer leaves
- `group-disband-list-visibility.spec.ts` — disbanded group no longer appears in member group list UI
- `group-disband-open-chat-behavior.spec.ts` — returning from an open disbanded group chat no longer leaves a stale group entry visible
- `group-disband-open-chat-return-list.spec.ts` — disbanded open group chats return cleanly to a refreshed group list state
- `group-detail-disband-return-list.spec.ts` — disbanded group detail views return cleanly to a refreshed group list state
- `group-detail-leave-return-list.spec.ts` — group detail views return cleanly to a refreshed group list after the viewer leaves

Run UI suites:

```bash
cd testing/ui
npm test
npm run test:dm
npm run test:group
```

### Important UI runner note
UI tests currently assume **single-worker execution** because they share live test accounts and websocket sessions.

Use:
- `playwright.config.ts -> workers: 1`
- package scripts with `--workers=1`

Do **not** assume these specs are safe to run in parallel until account/session isolation is added.

## Lifecycle recovery regression focus

The following 4 UI specs are the primary regression guardrails for group lifecycle recovery:

- `group-detail-leave-return-list.spec.ts`
- `group-detail-disband-return-list.spec.ts`
- `group-leave-open-chat-return-list.spec.ts`
- `group-disband-open-chat-return-list.spec.ts`

If recovery logic changes in `ChatScreen`, `GroupDetailScreen`, or `WebLayout`, run these first.

## Test auth/cache notes

- Protocol/UI seed scripts rely on `testing/drivers/botlandClient.js`.
- `testing/` needs the `ws` package installed for driver-based scenarios.
- Token cache lives at `testing/.token-cache.json`.
- The driver now checks JWT expiry before reusing cached access tokens, so expired cached tokens should trigger re-login automatically instead of causing repeated `401 invalid or expired token` failures.

## Notes

- Keep real secrets out of git. Use local copies of account config.
- Prefer stable, named actors over ad-hoc manual accounts.
- Dynamic group scenarios create temporary groups on the live BotLand environment.
- Live test residue should be cleaned automatically by `run-all.js`; if a scenario crashes halfway through, rerun the runner, run `node testing/scripts/cleanup-residue.js --run-id <run_id>`, then run `node testing/scripts/audit-residue.js --mode api`.
- Start with protocol verification, then layer UI verification on top.
- Several real bugs were already found and fixed through this test system, including:
  - group typing dispatch coverage
  - `GET /groups/:id` scan mismatch
  - `GET /groups` scan mismatch
  - DM history URL construction bug in web app
  - group reaction relay/broadcast gap
  - group system message persistence/history compatibility
  - group history `limit` parameter implementation gap
  - friend-request-first relationship flow is now the only intended onboarding path
