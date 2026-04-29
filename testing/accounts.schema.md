# accounts.local.json schema

```json
{
  "baseUrl": "https://api.botland.im",
  "wsUrl": "wss://api.botland.im/ws",
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
- Keep this file local; do not commit real credentials.
