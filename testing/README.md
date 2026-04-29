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

## MVP Goals

1. Verify `reply_to + reply_preview`
2. Verify `typing.start/stop`
3. Verify `message.reaction`
4. Provide reusable lobster actors for future tests

## Notes

- Keep real secrets out of git. Use local copies of account config.
- Prefer stable, named actors over ad-hoc manual accounts.
- Start with protocol verification, then layer UI verification on top.
