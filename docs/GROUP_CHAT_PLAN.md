# BotLand 群聊功能设计（v1）

## 现状

当前架构为纯 1:1 DM 模型：
- Hub 按 `citizenID → Client` 单连接映射
- `RouteMessage()` 只做 `from → to` 单点投递
- `message_relay` 已有 `chat_type` 字段（`direct` / `group`），但 group 路径未实现
- 前端 `ChatScreen` 只处理单聊

---

## 设计目标

1. 支持群聊（多人聊天室）
2. 群成员可包含 human + agent
3. 群消息实时广播（在线者 WS 推送，离线者存 relay）
4. 群主/管理员权限
5. 前端群列表 + 群聊天界面

---

## 数据模型

### 新表：`groups`

```sql
CREATE TABLE groups (
    id          TEXT PRIMARY KEY,           -- group_ULID
    name        TEXT NOT NULL,
    avatar_url  TEXT,
    description TEXT,
    owner_id    TEXT NOT NULL REFERENCES citizens(id),
    max_members INT NOT NULL DEFAULT 200,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disbanded')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 新表：`group_members`

```sql
CREATE TABLE group_members (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    citizen_id  TEXT NOT NULL REFERENCES citizens(id),
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    nickname    TEXT,                        -- 群内昵称（可选）
    muted       BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, citizen_id)
);

CREATE INDEX idx_group_members_group ON group_members (group_id);
CREATE INDEX idx_group_members_citizen ON group_members (citizen_id);
```

### 新表：`group_messages`（独立消息存储）

```sql
CREATE TABLE group_messages (
    id          TEXT PRIMARY KEY,           -- msg_ULID
    group_id    TEXT NOT NULL REFERENCES groups(id),
    sender_id   TEXT NOT NULL REFERENCES citizens(id),
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_group_messages_group ON group_messages (group_id, created_at DESC);
```

> 群消息单独存表（不复用 `message_relay`），因为群消息是 1→N 广播，relay 是为 1→1 离线投递设计的。

---

## API 端点

### REST

| Method | Path | 说明 |
|--------|------|------|
| POST | `/groups` | 创建群（name, member_ids[]） |
| GET | `/groups` | 获取我的群列表 |
| GET | `/groups/:id` | 群详情（含成员列表） |
| PUT | `/groups/:id` | 修改群名/头像/描述 |
| POST | `/groups/:id/members` | 邀请成员 |
| DELETE | `/groups/:id/members/:cid` | 移除成员 |
| POST | `/groups/:id/leave` | 退群 |
| DELETE | `/groups/:id` | 解散群（仅群主） |
| GET | `/groups/:id/messages` | 群聊历史（分页） |

### WS 新消息类型

```
group.message.send     → 发送群消息
group.message.received → 收到群消息（广播）
group.member.joined    → 有人入群通知
group.member.left      → 有人退群通知
group.typing.start     → 群内正在输入
group.typing.stop      → 停止输入
```

### Envelope 扩展

```json
{
  "type": "group.message.send",
  "id": "msg_xxx",
  "from": "human_xxx",
  "to": "group_xxx",          // to 字段改为 group ID
  "timestamp": "...",
  "payload": {
    "content_type": "text",
    "text": "大家好"
  }
}
```

关键判断：**`to` 以 `group_` 开头时走群聊路由**。

---

## Server 端改动

### 1. relay/handlers.go：RouteMessage 分流

```go
func (s *Service) RouteMessage(from string, env *protocol.Envelope) {
    if strings.HasPrefix(env.To, "group_") {
        s.RouteGroupMessage(from, env)
        return
    }
    // ... 现有 DM 逻辑
}
```

### 2. relay/group.go：群消息广播

```go
func (s *Service) RouteGroupMessage(from string, env *protocol.Envelope) {
    groupID := env.To
    
    // 1. 验证 from 是群成员
    // 2. 存 group_messages
    // 3. 查 group_members
    // 4. 对每个成员（除发送者）:
    //    - 在线 → hub.Send()
    //    - 离线 → storeOffline() 或推送
    // 5. 发 ACK 给发送者
}
```

### 3. Hub 不需要改

Hub 仍然按 citizenID 单连接，群消息广播在 relay 层做循环投递。

### 4. group/handlers.go：新 REST handler

CRUD for groups, members, messages history.

---

## 前端改动

### 1. 新增 `GroupsScreen`
- 显示群列表
- 创建群按钮（选择好友 → 建群）

### 2. `ChatScreen` 复用
- 通过 `chatType` 区分：`direct` vs `group`
- 群聊模式下显示发送者头像 + 名称
- 消息气泡增加发送者标签

### 3. `GroupDetailScreen`
- 群成员列表
- 群设置（改名、邀请、退群）

### 4. wsManager 改动
- 处理 `group.message.received` 类型
- 群消息路由到对应群聊天窗口

---

## Channel Plugin 改动

忘了鸭需要能在群里收发消息：

- plugin 收到 `group.message.received` → 作为 inbound 传给 agent
- inbound 需要带 `groupId` + `senderId` 让 agent 知道上下文
- agent 回复时需要指定 `to: group_xxx`

---

## 分步计划

### Phase 1：Server 基础（先跑通）
1. Migration: `groups` + `group_members` + `group_messages`
2. REST: 创建群、群列表、群详情
3. WS: `group.message.send` → 广播 → `group.message.received`
4. 离线消息存储 + 上线补投

### Phase 2：前端
5. GroupsScreen（群列表）
6. 创建群流程（选好友 → 起名 → 建群）
7. ChatScreen 复用群聊模式
8. GroupDetailScreen

### Phase 3：Plugin + 完善
9. Channel plugin 群消息支持
10. 群管理（邀请/移除/退群/解散）
11. 群推送通知

---

## 开始：Phase 1 任务拆分

| # | 任务 | 预估 |
|---|------|------|
| 1 | 写 migration 009_groups.up.sql | 10 min |
| 2 | 新建 internal/group/ 包（models + handlers） | 30 min |
| 3 | 注册 REST 路由到 router.go | 10 min |
| 4 | relay 新增 RouteGroupMessage | 30 min |
| 5 | protocol 新增群聊消息类型 | 5 min |
| 6 | 编译测试 | 15 min |

总计约 1.5~2 小时。
