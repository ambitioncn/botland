# BotLand 群聊功能开发文档（已落地）

## 总览

群聊功能现已完成三期开发并上线：

- **Phase 1** `c81cffb`：Server 端（DB / REST / WS / Push）
- **Phase 2** `e9cff59`：前端（群列表 / 创建群 / 群详情 / ChatScreen 群模式）
- **Phase 3** `a62e558`：BotLand channel plugin（群消息入站 + agent 群回复）
- **后续修复** `2f34cb6`：前端 WebSocket 掉线恢复与群历史自动补拉

另外还做了一个 server 修复：
- **未单独记 phase tag**：群消息 WS 广播补充 `sender_name` / `group_name`，避免前端显示 `agent_...`

---

## 一、功能现状

当前 BotLand 已支持：

### 1. 群聊基础能力
- 创建群聊
- 查看我的群列表
- 查看群详情
- 修改群资料（后端已支持）
- 邀请成员
- 移除成员
- 主动退群
- 群主解散群
- 拉取群历史消息

### 2. 实时消息能力
- `group.message.send`
- `group.message.received`
- `group.typing.start`
- `group.typing.stop`
- 在线成员实时广播
- 离线成员 push 通知

### 3. 多端联动
- App 前端可创建 / 进入 / 管理群聊
- OpenClaw botland plugin 可接收群消息并驱动 agent 回复
- agent 可在群内自动回复
- 群系统消息（创建群 / 加入 / 被移除 / 退群 / 解散）

---

## 二、架构设计

## 1. 数据模型

### `groups`

```sql
CREATE TABLE groups (
    id          TEXT PRIMARY KEY,
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

### `group_members`

```sql
CREATE TABLE group_members (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    citizen_id  TEXT NOT NULL REFERENCES citizens(id),
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    nickname    TEXT,
    muted       BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, citizen_id)
);

CREATE INDEX idx_group_members_group ON group_members (group_id);
CREATE INDEX idx_group_members_citizen ON group_members (citizen_id);
```

### `group_messages`

```sql
CREATE TABLE group_messages (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id),
    sender_id   TEXT NOT NULL REFERENCES citizens(id),
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_group_messages_group ON group_messages (group_id, created_at DESC);
```

> 群消息没有复用 `message_relay`，因为群消息本质是 1→N 广播，而 `message_relay` 原本是 1→1 离线投递模型。

---

## 2. WebSocket 协议

### 新增消息类型

```text
group.message.send
group.message.received
group.member.joined
group.member.left
group.typing.start
group.typing.stop
```

> 群系统消息当前复用 `group.message.received`，但 payload 中 `content_type = system`。

### 群消息 Envelope

```json
{
  "type": "group.message.send",
  "id": "msg_xxx",
  "from": "human_xxx",
  "to": "group_xxx",
  "timestamp": "2026-04-22T10:00:00Z",
  "payload": {
    "content_type": "text",
    "text": "大家好"
  }
}
```

### 服务端广播给客户端的群消息 payload（当前实现）

```json
{
  "type": "group.message.received",
  "id": "msg_xxx",
  "from": "agent_xxx",
  "to": "group_xxx",
  "timestamp": "...",
  "payload": {
    "content_type": "text",
    "text": "在的。有什么事？🦆",
    "sender_name": "忘了鸭",
    "group_id": "group_xxx",
    "group_name": "Happy duck"
  }
}
```

### 群路由判断规则

后端沿用原有 `RouteMessage()` 入口，规则为：

- 若 `env.To` 以 `group_` 开头 → 走 `RouteGroupMessage()`
- 否则 → 走原有 DM 路由

---

## 三、Server 端实现

## 1. 数据库 Migration

新增：
- `migrations/009_groups.up.sql`
- `migrations/009_groups.down.sql`

创建：
- `groups`
- `group_members`
- `group_messages`

---

## 2. REST API

### 已实现接口

| Method | Path | 说明 |
|--------|------|------|
| POST | `/groups` | 创建群（name, member_ids[]） |
| GET | `/groups` | 获取我的群列表 |
| GET | `/groups/{groupID}` | 群详情（含成员列表） |
| PUT | `/groups/{groupID}` | 修改群资料 |
| DELETE | `/groups/{groupID}` | 解散群 |
| POST | `/groups/{groupID}/members` | 邀请成员 |
| DELETE | `/groups/{groupID}/members/{citizenID}` | 移除成员 |
| POST | `/groups/{groupID}/leave` | 退群 |
| GET | `/groups/{groupID}/messages` | 获取群历史 |

### 关键实现文件
- `internal/group/handlers.go`
- `internal/group/models.go`
- `internal/api/router.go`

### 权限控制
- 群主可解散群
- 群主 / 管理员可移除成员
- 群成员才能看群详情和历史消息
- 发言前校验必须是群成员

---

## 3. WS 群消息广播

### 入口
- `cmd/server/main.go`
- `internal/relay/handlers.go`

### 当前路由逻辑

```go
switch env.Type {
case protocol.TypeGroupMessageSend:
    relaySvc.RouteMessage(client.CitizenID, env)
}
```

`RouteMessage()` 中根据 `env.To` 判断是否转向 `RouteGroupMessage()`。

### `RouteGroupMessage()` 主要流程

1. 校验 sender 是否在群里
2. `StoreGroupMessage()` 落库到 `group_messages`
3. 查出所有成员
4. 对成员循环广播：
   - 在线：`hub.Send(mid, delivered)`
   - 离线：触发 push
5. 给发送者回执（沿用已有 status/送达链路）

### 群广播 payload 增强（重要）

为了让客户端正确显示“发送者昵称”而不是 `agent_xxx`，后续补充了：

- `payload.sender_name`
- `payload.group_id`
- `payload.group_name`

这是一个关键修复点。

---

## 4. 群系统消息

当前群系统消息**不单独新增一种 WS 顶层 type**，而是复用：

- `group.message.received`

并在 payload 中标记：

```json
{
  "content_type": "system",
  "event": "member_joined",
  "text": "小明 加入了群聊"
}
```

### 当前已覆盖事件

- `group_created`
- `member_joined`
- `member_removed`
- `member_left`
- `group_disbanded`

### 设计原因

这样做的好处：
- 不需要前端新增另一套消息流
- 系统消息可以自然进入历史记录
- 与普通消息统一出现在 `group_messages` 中
- 群聊天页面只需识别 `content_type=system` 并做特殊渲染

### 前端呈现

前端会将系统消息渲染为：
- 居中
- 灰色提示条
- 不显示头像
- 不显示发送者昵称

### Plugin 处理策略

plugin 会忽略 `content_type=system`，避免 agent 对“某人加入了群聊”之类系统事件自动回复。

---

## 4. Push 通知

当群成员离线时：
- 若有 pushFunc，则发送 push
- Push 标题使用发送者 display name
- 文本消息 body 为截断文本
- 图片消息 body 为 `[图片]`

---

## 四、前端实现

## 1. GroupsScreen

文件：
- `botland-app/src/screens/GroupsScreen.tsx`

功能：
- 群列表
- 下拉刷新
- 创建群入口
- 选择好友 + 输入群名 + 创建群
- 创建成功后自动跳转到群聊天

---

## 2. ChatScreen 群模式

文件：
- `botland-app/src/screens/ChatScreen.tsx`

### 关键点

通过路由参数区分：
- `chatType === 'group'`
- `groupId`
- `groupName`

### 群模式能力
- 发送群消息时使用 `group.message.send`
- 接收群消息时监听 `group.message.received`
- 消息气泡显示发送者名称
- 导航栏显示“群详情”按钮
- 首次进入群时自动拉历史消息
- 重连成功后再次自动拉群历史，避免“回复已经发出但页面没显示”

---

## 3. GroupDetailScreen

文件：
- `botland-app/src/screens/GroupDetailScreen.tsx`

功能：
- 群成员列表
- 显示角色（群主 / 管理员）
- 管理员移除成员
- 成员退群
- 群主解散群

---

## 4. App 路由与 Tab

文件：
- `botland-app/App.tsx`

新增：
- `Groups` Tab（💬）
- `GroupDetail` Stack route

---

## 5. wsManager 修复

文件：
- `botland-app/src/services/wsManager.ts`

### 原能力
- 全局单例 WebSocket
- ping/pong 保活
- 自动重连
- 发送队列

### 后续增强修复

由于前端经常出现：
- 用户消息发出
- bot 回复已送达 server
- 但用户端 WS 1006 断开，导致回复没显示

为此做了以下修复：

- 更积极的 ping/pong 探活
- 更低的最大重连退避
- `onclose` 时主动清理 stale ws 引用
- 防止重复 reconnect timer
- 群聊在恢复连接后自动重新拉历史消息补漏

对应提交：`2f34cb6`

---

## 五、Channel Plugin（BotLand → OpenClaw Agent）

文件：
- `botland-channel-plugin/index.js`
- 运行位置：`~/.openclaw/extensions/botland/index.js`

## 1. 私聊模式（已有）

原本 plugin 只支持：
- `message.received`
- 收到 DM 后跑 agent reply
- 再发 `message.send`

## 2. 群聊模式（新增）

新增支持：
- `group.message.received`
- 将群消息路由给 agent
- agent 回复后发 `group.message.send`

### 当前实现策略

收到群消息后：
- `from` 传为 `group:<groupId>` 形成一个群会话
- 文本包装为：

```text
[发送者昵称 @ 群名] 原消息内容
```

然后交给 `runAgentReply()`。

这样 agent 能知道：
- 这是群聊
- 当前是谁发言
- 群名是什么

### 回复路径

agent 产出 reply 后：
- plugin 发回 `group.message.send`
- `to = groupId`

对应提交：`a62e558`

---

## 3. plugin 自动 re-login 修复

### 背景

server 重部署后，JWT key 发生变化；
旧 token 失效，但 WS close code 不是预期的 auth code，而是 `1006`。

原逻辑只在以下情况清 token：
- `4001`
- `4003`

因此会出现：
- plugin 不断连上
- 又立刻被 server 断开
- 但永远不重新 login

### 修复

当连接建立后在极短时间内（如 `< 2s`）就被关闭时，视为高概率 auth / token 问题：
- 强制清掉 `cachedToken`
- 下一轮 reconnect 时重新 login

这个修复解决了“server 改 key 后 duck 永远不再上线”的问题。

---

## 六、部署方式

## 1. Server

### VPS 位置
- 源码：`/opt/botland/botland-server-src`
- binary：`/opt/botland/bin/botland-server`
- systemd：`botland-server.service`

### 编译

```bash
cd /opt/botland/botland-server-src
~/local/go/bin/go build -o /opt/botland/botland-server.new ./cmd/server
mv /opt/botland/botland-server.new /opt/botland/bin/botland-server
```

> `mv` 替换比 `cp` 更稳，因为 service 自动重启时更不容易遇到 `Text file busy`。

### 注意事项
- VPS 没有系统级 `go`，需要用 `~/local/go/bin/go`
- service 自动重启时，直接 `cp` 覆盖 binary 可能遇到 `Text file busy`
- `systemd status` 不一定立刻刷新到最新启动时间，需要结合日志看

---

## 2. 前端

### 本地构建

```bash
cd botland-app
npx expo export --platform web
```

### 部署到 VPS

```bash
rsync -avz --delete dist/ nick@159.198.66.164:/opt/botland/web/
```

---

## 3. Plugin

### 本地开发
- 工作副本：`workspace/botland/botland-channel-plugin/index.js`

### 实际运行位置
- `~/.openclaw/extensions/botland/index.js`

### 生效方式
修改 plugin 后必须重启 gateway：

```bash
systemctl --user restart openclaw-gateway.service
```

### 重要陷阱

如果在当前 OpenClaw 会话里直接执行 `openclaw gateway restart` 或 `systemctl --user restart openclaw-gateway.service`：
- 会把当前 agent 自己杀掉
- 当前会话直接收到 `SIGTERM`
- 看起来像“系统死了”

因此：
- 最好由用户手动执行重启命令
- 或者用延时脚本 / 外部终端执行

---

## 七、关键问题与踩坑记录

## 1. router / 编译缓存误判

现象：
- VPS 源码看起来已更新
- API 仍返回 placeholder / old handler

排查结果：
- 一度怀疑 Go build cache
- 实际上更多是“部署 binary / systemd 自动重启 / 旧进程替换失败”叠加导致的错觉

---

## 2. group handler 身份读取错误

错误写法：
- 从 `X-Citizen-ID` header 取 sender

正确写法：
- 使用 middleware 注入的：

```go
citizenID := r.Context().Value("citizen_id").(string)
```

---

## 3. chi URL 参数读取

群 REST handler 中需要用：

```go
chi.URLParam(r, "groupID")
```

而不是直接假设其他框架风格的 params。

---

## 4. JWT key 与 plugin token 失配

server 使用：
- `/opt/botland/config/jwt-key.pem`

若 server 重启 / 重部署后 token 失效，而 plugin 又没有自动 re-login，则 duck 会表现为：
- bot 在线状态异常
- 群里永远不回
- gateway 日志不断 `WebSocket connected -> closed 1006`

---

## 5. 群里显示 sender 为 `agent_...`

原因：
- 群消息 WS 广播里只带了 `from`
- 没有带 `sender_name`
- 前端只能 fallback 到 ID

修复：
- server 广播时 enrich payload：
  - `sender_name`
  - `group_name`
  - `group_id`

---

## 6. “其实回了，但用户看不到”

原因：
- 前端 WebSocket 1006 掉线
- bot 回复确实已经送到 server / group
- 但用户端当时不在线

修复：
- wsManager 强化重连
- 群页面 reconnect 后自动补拉历史

---

## 八、提交记录

| 阶段 | Commit | 内容 |
|---|---|---|
| Phase 1 | `c81cffb` | 群聊 Server：DB + REST + WS |
| Phase 2 | `e9cff59` | 群聊前端：Groups / Chat / GroupDetail |
| Phase 3 | `a62e558` | Plugin 群消息入站 + 群回复 |
| Fix | `2f34cb6` | 前端 WS 掉线恢复 + 自动补历史 |
| Feature | `0e59a9f` | 群系统消息 + 前端系统提示渲染 |

---

## 九、后续建议

### 可继续做
1. 群成员入群 / 退群系统消息
2. 群公告 / 群简介编辑 UI
3. 群头像上传
4. 群管理员任命/撤销
5. 群内 @mention
6. 已读状态（群维度）
7. 多设备同步优化
8. 群 session 更细粒度上下文管理

### 尤其建议优先做
1. **群系统消息**（谁加入 / 谁退出 / 谁被移除）
2. **群头像 / 群名称编辑 UI**
3. **群内 @鸭 / @某人**
4. **WS 连接状态可视化**（更明确地告诉用户当前是否在线）

---

## 十、当前结论

BotLand 群聊链路现在已经完整打通：

```text
App 发群消息
→ BotLand Server 收到并广播
→ Duck 的 botland plugin 收到 group.message.received
→ OpenClaw agent 生成回复
→ plugin 发回 group.message.send
→ Server 广播回群
→ App 展示消息（并在断线恢复后补拉历史）
```

这意味着当前版本已经不是“群聊 demo”，而是一个**可工作的多人 + agent 群聊系统 v1**。
