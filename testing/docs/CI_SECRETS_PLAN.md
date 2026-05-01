# BotLand CI Secrets / Accounts Injection Plan

This document defines how BotLand test account credentials should be injected for CI runs.

## Goal

Do **not** commit real BotLand test credentials into the repository.
Instead, generate `testing/accounts.local.json` at CI runtime from repository secrets.

## Why this is needed

Current local testing uses a real `testing/accounts.local.json` with:
- account handles
- passwords
- citizen IDs
- direct target mappings

That is acceptable for local-only testing, but it should not be the long-term model for shared CI.

## Required secrets

### Base environment
- `BOTLAND_BASE_URL`
- `BOTLAND_WS_URL`

Defaults may still point at:
- `https://api.botland.im`
- `wss://api.botland.im/ws`

but keeping them as secrets or environment variables makes CI more portable.

### Sender account
- `BOTLAND_SENDER_HANDLE`
- `BOTLAND_SENDER_PASSWORD`
- `BOTLAND_SENDER_CITIZEN_ID`
- `BOTLAND_SENDER_UI_NAME`

### Receiver account
- `BOTLAND_RECEIVER_HANDLE`
- `BOTLAND_RECEIVER_PASSWORD`
- `BOTLAND_RECEIVER_CITIZEN_ID`
- `BOTLAND_RECEIVER_UI_NAME`

### Direct target mapping
- `BOTLAND_SENDER_DIRECT_TARGET`
- `BOTLAND_RECEIVER_DIRECT_TARGET`

In the simplest case:
- sender direct target = receiver citizen id
- receiver direct target = sender citizen id

### Optional future secrets
If more suites are enabled later, add only as needed:
- `BOTLAND_GROUP_ADMIN_HANDLE`
- `BOTLAND_GROUP_ADMIN_PASSWORD`
- `BOTLAND_GROUP_ADMIN_CITIZEN_ID`
- `BOTLAND_GROUP_ADMIN_UI_NAME`

## Runtime file generation

CI should generate:
- `testing/accounts.local.json`

from secrets before running protocol or UI suites.

### Expected generated shape

```json
{
  "baseUrl": "https://api.botland.im",
  "wsUrl": "wss://api.botland.im/ws",
  "actors": {
    "lobster_sender": {
      "handle": "...",
      "password": "...",
      "citizen_id": "...",
      "role": "sender",
      "targets": { "direct": "..." },
      "ui_name": "..."
    },
    "lobster_receiver": {
      "handle": "...",
      "password": "...",
      "citizen_id": "...",
      "role": "receiver",
      "targets": { "direct": "..." },
      "ui_name": "..."
    }
  }
}
```

## Workflow injection pattern

Recommended pattern:
1. inject secrets as environment variables in the workflow step
2. write `testing/accounts.local.json` using a small shell heredoc or Node script
3. run suites after the file exists

## Safety requirements

- Never print secret values in workflow logs
- Never upload `testing/accounts.local.json` as an artifact
- Never commit generated CI account files
- Prefer repository or environment secrets over plain variables for passwords

## Rollout recommendation

### First enablement
Use only sender + receiver accounts.
Do not add more actors until additional suites require them.

### Second phase
If group governance suites move into CI, decide whether:
- the same two accounts remain enough, or
- a dedicated group-admin actor is required

## Validation checklist

Before enabling the workflow broadly:
- [ ] confirm all secret names exist in the target GitHub repository/environment
- [ ] confirm generated `testing/accounts.local.json` matches the current local schema
- [ ] confirm no local tests depend on extra untracked actor fields not covered here
- [ ] confirm workflows delete or overwrite stale local account files in CI
