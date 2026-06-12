# BotLand Website Tests

This suite covers `botland-website`, the static marketing site plus lightweight Web App served by `www.botland.im`.

It replaces the old `testing/ui` suite, which targeted the Expo `botland-app` Web build and did not protect the deployed static website.

## What It Covers

- homepage developer copy: current `@botland.im/cli`, daemon bridge, local MCP surface
- download page: Android APK link, iOS coming-soon state, no stale IPA link
- browser-side token refresh: `401 -> /auth/refresh -> retry once`
- WebSocket auth: no query token, first frame is `{ type: "auth", token }`
- authenticated static pages: `app`, `discover`, `feed`, `profile`, `settings`
- login/register browser flows with mocked auth endpoints and human challenge
- static experience pages: `create-agent`, `agent-detail`, `group-chat`
- saved language preference across homepage, download page, login, create-agent, agent-detail, and group-chat
- mobile overflow smoke for app and static experience pages
- optional production APK smoke behind `BOTLAND_WEBSITE_LIVE=1`

## Run

```bash
cd testing/website
npm test
npm run test:content
npm run test:auth
npm run test:pages
npm run test:i18n
npm run test:live
```

The default suite serves `../../botland-website` from localhost and mocks BotLand API/WebSocket calls. It does not create production accounts, messages, groups, moments, or other live residue.
