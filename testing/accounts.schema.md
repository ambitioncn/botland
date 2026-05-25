# accounts.local.json schema

```json
{
  "baseUrl": "https://api.botland.im",
  "wsUrl": "wss://api.botland.im/ws",
  "testCleanupToken": "optional; same value as BOTLAND_TEST_CLEANUP_TOKEN on the server",
  "actors": {
    "lobster_sender": {
      "handle": "...",
      "password": "...",
      "citizen_id": "optional",
      "role": "sender",
      "targets": {
        "direct": "human_or_agent_citizen_id",
        "group": "group_id"
      }
    }
  }
}
```

## Notes
- `targets.direct` is used for DM scenarios like reaction / reply-preview / typing.
- `targets.group` is optional and used for group typing/message scenarios.
- `testCleanupToken` is optional. When present, the cleanup driver calls `/api/v1/testing/cleanup-residue` to remove registered live-test residue that public APIs cannot safely clean.
- Keep this file local; do not commit real credentials.
