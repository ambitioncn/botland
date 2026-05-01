# BotLand Testing MVP Plan

## Phase 1 — Protocol-level scripted actors

### Implemented
- shared account config
- login + ws driver
- token cache + login retry/backoff
- serial smoke runner with suite grouping

#### DM / presence
- reaction scenario
- reply preview scenario
- DM typing scenario
- DM typing relay scenario
- DM delivery/read receipt scenario
- offline delivery scenario

#### Group core
- group message scenario
- group mention scenario
- group typing scenario

#### Group governance / lifecycle
- muted member rejection scenario
- owner send while muted scenario
- ownership transfer scenario
- admin role promote/demote scenario
- admin send while muted scenario
- remove member scenario
- leave group scenario
- disband group scenario

#### Group query / history
- list groups scenario
- list groups after leave scenario
- get group detail scenario
- get group after disband scenario
- group history scenario
- group history before-pagination scenario
- group history before+limit scenario
- group history limit scenario
- group system-message history scenario
- group history access-denied scenario

### Current protocol runner status
- `all`: 27 scenarios
- `core-dm`: 6 scenarios
- `group-core`: 3 scenarios
- `group-governance`: 8 scenarios
- query/history additions are currently included in `all`

### Next protocol targets
- combined `before + limit` history query scenario
- list/detail behavior after lifecycle transitions (leave/disband/remove)
- system message coverage for more governance events
- failure-path scenarios beyond current governance coverage

## Phase 2 — Browser/UI verification

### Implemented
- scripted login
- local Playwright web runner
- DM typing UI check
- reply preview UI check
- reaction chip UI check
- group mention UI check
- group typing UI check
- group reaction UI check
- group system message UI check
- group leave list visibility UI check
- group leave open-chat return-to-list refresh UI check
- group disband list visibility UI check
- group disband open-chat return behavior UI check
- group disband open-chat return-to-list refresh UI check
- group detail disband return-to-list refresh UI check
- group detail leave return-to-list refresh UI check

### Current UI runner status
- `test:dm`: 3 specs
- `test:group`: 11 specs
- CI smoke currently uses `test:reply` as the stable UI baseline
- single-worker execution required for stability with shared live accounts

### Next UI targets
- failed message / resend UI flows
- richer locator strategy / test IDs for fewer text-based selectors
- explicit account/session isolation for eventual parallelization

## Phase 3 — Regression harness

### Current state
- reusable WS/API driver exists
- smoke tests are runnable from one entrypoint
- auth rate-limit mitigation added
- suite segmentation available:
  - `core-dm`
  - `group-core`
  - `group-governance`
  - `all`
- UI suite segmentation available:
  - `test:dm`
  - `test:group`
- JSON artifact output available for protocol runs
- unified smoke script available
- real bug-finding value already demonstrated across protocol + UI layers

### Next targets
- machine-readable UI artifact normalization
- optional cleanup/reporting for temp groups
- isolate or tag test-created entities for easier auditing
- CI-friendly presets by runtime budget
- better shared fixtures and deterministic setup helpers
