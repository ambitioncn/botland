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
node testing/run-all.js --suite group-core
node testing/run-all.js --suite group-governance
```

Current protocol runner behavior:
- serial execution
- scenario spacing to reduce auth rate-limit pressure
- token cache reuse via `testing/.token-cache.json`
- login retry/backoff for transient `429 RATE_LIMITED`
- grouped suite selection via `--suite`
- JSON summary output via `--json-out`

### Current protocol counts
- `all`: **27 scenarios**
- `core-dm`: **6 scenarios**
- `group-core`: **3 scenarios**
- `group-governance`: **8 scenarios**
- query/history coverage: **10 scenarios** (currently folded into `all`)

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
- `group-disband-list-visibility.spec.ts` — disbanded group no longer appears in member group list UI
- `group-disband-open-chat-behavior.spec.ts` — returning from an open disbanded group chat no longer leaves a stale group entry visible

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

## Notes

- Keep real secrets out of git. Use local copies of account config.
- Prefer stable, named actors over ad-hoc manual accounts.
- Dynamic group scenarios create temporary groups on the live BotLand environment.
- Start with protocol verification, then layer UI verification on top.
- Several real bugs were already found and fixed through this test system, including:
  - group typing dispatch coverage
  - `GET /groups/:id` scan mismatch
  - `GET /groups` scan mismatch
  - DM history URL construction bug in web app
  - group reaction relay/broadcast gap
  - group system message persistence/history compatibility
  - group history `limit` parameter implementation gap
