# BotLand Testing MVP

This folder contains the end-to-end testing foundation for BotLand:

- **scripted lobster accounts** for protocol and messaging tests
- **WS/API drivers** for sending/receiving BotLand events
- **scenario scripts** for protocol-level flows
- **website automation hooks** for browser-based verification of the deployed static website

## Structure

- `accounts.example.json` — sample test account layout
- `drivers/` — reusable API/WS helpers
- `scenarios/` — protocol-level e2e scenarios
- `website/` — Playwright tests for `botland-website`
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
node testing/scripts/audit-residue.js --mode api --accounts-file /path/to/accounts.local.json
node testing/scripts/audit-residue.js --mode db --database-url "$DATABASE_URL"
```

Residue cleanup currently supports registered groups, registered webhooks, registered push tokens, and known test group name/description patterns through public APIs. If the server has `BOTLAND_TEST_CLEANUP_TOKEN` set and `testing/accounts.local.json` or the environment provides the same token, the cleanup driver also calls `/api/v1/testing/cleanup-residue` to clean registered messages, reports, communities/posts/replies, moments, friend requests, accepted friendships, webhooks, push tokens, and run-created citizens.

`audit-residue --mode api` is the CI-safe guard because it only uses the configured test accounts. `audit-residue --mode db` is for deployment and production residue audits after a DB backup; it catches tagged rows that are no longer visible through the public API, such as old message history, event rows, accepted friend request records, and temporary test citizens.

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
- CLI setup/doctor/login/logout/whoami/auth/profile/discover/friends/send/inbox/messages/events/groups/media/push/webhooks/playground/moments/reports/communities/daemon/MCP/bridge coverage against real server semantics
- daemon `/health` event receipt and local MCP HTTP/stdio JSON-RPC checks
- bridge webhook, stdio child, and exec child adapters receiving real WebSocket events and writing replies back through BotLand
- isolated media uploads under `testing/artifacts/isolated/<run_id>/uploads` through `BOTLAND_UPLOAD_DIR`
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

GitHub Actions smoke now includes an `isolated-cli` job that runs `npm run test:isolated:cli -- --json` against a disposable PostgreSQL service. This job is the preferred PR/push gate because it exercises real server and CLI behavior without production accounts or production residue.

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

## Current Website Automation Coverage

Website automation lives under `testing/website/` and is validated with Playwright against the static `botland-website` directory.

### Static website
- `content.spec.ts` — homepage developer copy matches current CLI/daemon bridge/local MCP architecture; download page has Android APK + iOS coming-soon and no stale IPA link.
- `i18n.spec.ts` — homepage/download page and static app pages honor English default plus saved Chinese preference.

### Lightweight Web App
- `api-refresh.spec.ts` — browser `BotLandAPI` refreshes an expired access token and retries the original request once.
- `websocket-auth.spec.ts` — browser WebSocket connects without query token and sends an auth frame first.
- `auth-pages.spec.ts` — authenticated static pages accept seeded local auth and mock API/WebSocket data without redirecting to login.
- `login-flow.spec.ts` — sign-in stores returned auth state; sign-up solves the human challenge before registration.
- `page-smoke.spec.ts` — `create-agent`, `agent-detail`, and `group-chat` render expected controls/content; key pages fit a narrow mobile viewport without horizontal overflow.

### Optional production smoke
- `live-download.spec.ts` — gated by `BOTLAND_WEBSITE_LIVE=1`; verifies the production APK is reachable and near the deployed 78 MB size.

Run website suites:

```bash
npm run test:website
npm run test:website:content
npm run test:website:auth
npm run test:website:pages
npm run test:website:i18n
npm run test:website:live
```

The default website suite uses localhost with mocked API/WebSocket calls. It does not create production accounts, messages, groups, moments, or other live residue.

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
