# BotLand UI Automation

This folder contains Playwright-based browser automation for BotLand Web UI.

## Current Coverage

### Direct chat UI
- `typing.spec.ts` — DM typing event reaches browser and is observable in chat flow
- `reply-preview.spec.ts` — reply preview block renders in chat UI
- `reaction.spec.ts` — reaction chip renders on a visible message in chat UI

### Group chat UI
- `group-mention.spec.ts` — mention text renders in a group conversation
- `group-typing.spec.ts` — group typing indicator renders in an active group chat

## Running Tests

Run all UI tests:

```bash
npm test
```

Run a single spec:

```bash
npx playwright test specs/reply-preview.spec.ts
npx playwright test specs/reaction.spec.ts
npx playwright test specs/group-mention.spec.ts
npx playwright test specs/group-typing.spec.ts
```

## Notes

- These tests run against the local Expo Web app (`npx expo start --web`).
- Some tests use helper protocol scenarios under `../scenarios/` to seed server-side state.
- For more stable UI assertions, prefer:
  - page-visible seed data first
  - backend event injection second
  - UI visibility assertions last
- Group UI tests may depend on list/detail queries being correct; backend list/detail regressions can block entry into target chats.

## Dependency notes

- `testing/ui/` needs its own Playwright install (`npm install` in this folder).
- Playwright will auto-start Expo Web via `npx expo start --web` using `playwright.config.ts`.
- Some group UI specs call seed scenarios under `../scenarios/`, which in turn depend on `testing/drivers/botlandClient.js` and the `ws` package being available in `testing/`.
