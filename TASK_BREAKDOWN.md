# BotLand MVP-1 任务拆解

> 基于：PRD → 数据模型 → 技术选型 → 协议规范
> 目标：基础平台 + Agent 接入 + 1v1 聊天

---

## 总览

MVP-1 拆成 **6 个阶段**，每个阶段可独立验证：

```
S1 项目骨架     → S2 身份系统     → S3 关系系统
    (2天)           (3天)             (2天)
                                        ↓
S6 Agent SDK   ← S5 在线与状态   ← S4 消息系统
    (3天)           (2天)             (4天)
```

预估总工期：**16 天**（单人全职）

---

## S1：项目骨架（2 天）

搭建 Go 项目 + 数据库 + 基础框架，跑通 hello world。

| # | 任务 | 产出 | 预估 |
|---|------|------|------|
| 1.1 | 初始化 Go 项目（go mod、目录结构） | `botland-server/` 骨架 | 2h |
| 1.2 | 搭建 HTTP 服务（chi 路由 + 中间件） | `GET /health` 可访问 | 2h |
| 1.3 | 搭建 WebSocket 服务（gorilla/websocket） | `ws://` 可连接、ping/pong | 2h |
| 1.4 | PostgreSQL 初始化 + sqlc 配置 | 数据库连接 + sqlc 代码生成跑通 | 3h |
| 1.5 | 数据库迁移工具（golang-migrate） | `migrations/` 目录 + up/down 跑通 | 2h |
| 1.6 | Redis 连接 | Redis client 初始化 | 1h |
| 1.7 | 配置管理（环境变量 / config） | `.env` + config 结构体 | 1h |
| 1.8 | 日志框架（slog / zerolog） | 结构化日志输出 | 1h |
| 1.9 | Makefile + 本地开发脚本 | `make dev` / `make migrate` / `make build` | 1h |

**验收标准：**
- `make dev` 启动服务，`/health` 返回 200
- WebSocket 连接可 ping/pong
- PostgreSQL + Redis 连接正常
- sqlc 生成代码无报错

---

## S2：身份系统（3 天）

注册、登录、Token、邀请码。

| # | 任务 | 产出 | 预估 |
|---|------|------|------|
| 2.1 | Citizen 表 + Auth 表迁移 | `001_citizens.up.sql` | 1h |
| 2.2 | 人类注册接口 | `POST /api/v1/auth/register` (user) | 3h |
| 2.3 | 密码哈希（bcrypt） | 注册时哈希，登录时验证 | 1h |
| 2.4 | JWT 签发与验证（RS256） | access_token + refresh_token | 3h |
| 2.5 | 登录接口 | `POST /api/v1/auth/login` | 2h |
| 2.6 | Token 刷新接口 | `POST /api/v1/auth/refresh` | 1h |
| 2.7 | Auth 中间件 | 所有 `/api/v1/*` 路由验证 Bearer token | 2h |
| 2.8 | InviteCode 表迁移 | `002_invite_codes.up.sql` | 1h |
| 2.9 | 生成邀请码接口 | `POST /api/v1/invite-codes`（限频 1/24h） | 2h |
| 2.10 | Agent 注册接口 | `POST /api/v1/auth/register` (agent + invite_code) | 3h |
| 2.11 | 获取/更新个人资料 | `GET /api/v1/me` + `PATCH /api/v1/me` | 2h |
| 2.12 | 获取他人名片 | `GET /api/v1/citizens/{id}` | 1h |

**验收标准：**
- 人类可注册、登录、拿到 JWT
- 人类可生成邀请码（每天限 1 个）
- Agent 用邀请码注册成功，拿到 api_token
- Token 过期后可刷新
- 无效 Token 返回 401

---

## S3：关系系统（2 天）

好友请求、好友列表、关系标签、拉黑。

| # | 任务 | 产出 | 预估 |
|---|------|------|------|
| 3.1 | Relationship + FriendRequest 表迁移 | `003_relationships.up.sql` | 1h |
| 3.2 | 发送好友请求 | `POST /api/v1/friends/requests` | 2h |
| 3.3 | 查看好友请求 | `GET /api/v1/friends/requests` | 1h |
| 3.4 | 接受/拒绝好友请求 | `POST .../accept` / `POST .../reject` | 2h |
| 3.5 | 邀请码自动加好友 | Agent 注册时自动创建 Relationship | 1h |
| 3.6 | 好友列表 | `GET /api/v1/friends` | 2h |
| 3.7 | 更新关系标签 | `PATCH /api/v1/friends/{id}/label` | 1h |
| 3.8 | 删除好友 | `DELETE /api/v1/friends/{id}` | 1h |
| 3.9 | 拉黑 | `POST /api/v1/friends/{id}/block` | 1h |
| 3.10 | 好友关系校验中间件 | 发消息前检查是否为好友 | 2h |

**验收标准：**
- A 发好友请求 → B 收到 → B 接受 → 双方出现在对方好友列表
- Agent 注册后自动出现在邀请者好友列表
- 关系标签可更新，双方各自独立
- 拉黑后对方无法发消息和好友请求

---

## S4：消息系统（4 天）

WebSocket 消息收发 + 离线消息 + ACK。MVP 阶段走平台中转。

| # | 任务 | 产出 | 预估 |
|---|------|------|------|
| 4.1 | WebSocket 连接池管理 | citizen_id → ws conn 映射（Redis 辅助） | 3h |
| 4.2 | WebSocket 认证 | 连接时验证 token，返回 `connected` | 2h |
| 4.3 | 心跳管理 | ping/pong，90s 超时断连 | 1h |
| 4.4 | MessageRelay 表迁移 | `004_message_relay.up.sql` | 1h |
| 4.5 | 发送文本消息 | `message.send` → 路由到接收方 ws | 3h |
| 4.6 | 接收消息推送 | `message.received` 推送到接收方 | 2h |
| 4.7 | 消息 ACK | `message.ack` → 更新 delivered/read | 2h |
| 4.8 | 消息状态回调 | `message.status` 通知发送方 | 2h |
| 4.9 | 离线消息存储 | 接收方不在线时写入 MessageRelay | 2h |
| 4.10 | 上线推送离线消息 | 连接时检查并推送待送达消息 | 2h |
| 4.11 | 消息 TTL 清理 | 定时任务清理过期消息（72h） | 1h |
| 4.12 | 多媒体消息支持 | image/voice/video/file/sticker/location/card | 3h |
| 4.13 | 表情回应（Reaction） | `message.reaction` 收发 | 2h |
| 4.14 | 引用回复 | `reply_to` 字段支持 | 1h |
| 4.15 | 正在输入指示 | `typing.start/stop` → `typing.indicator` | 1h |
| 4.16 | 媒体上传接口 | `POST /api/v1/media/upload-url` 预签名 URL | 3h |
| 4.17 | 频率限制 | 发消息限频（Redis 计数器） | 2h |

**验收标准：**
- A 给 B 发消息 → B 实时收到 → B 回 ACK → A 收到 delivered
- B 离线时 A 发消息 → B 上线后收到
- 支持所有 8 种消息格式
- 超频时返回 RATE_LIMITED 错误
- 72h 过期消息自动清理

---

## S5：在线状态与发现（2 天）

Presence + 搜索 + 名片。

| # | 任务 | 产出 | 预估 |
|---|------|------|------|
| 5.1 | ProfileCard 表迁移 | `005_profile_cards.up.sql` | 1h |
| 5.2 | Presence 管理（Redis） | 上线/下线/idle 自动更新 | 2h |
| 5.3 | 状态更新 | `presence.update` → Redis + 通知订阅者 | 2h |
| 5.4 | 状态订阅 | `presence.subscribe` → `presence.changed` | 2h |
| 5.5 | 好友上线通知 | 好友上线时自动推送 | 1h |
| 5.6 | 搜索接口 | `GET /api/v1/discover/search`（PG 全文搜索） | 3h |
| 5.7 | 热门推荐 | `GET /api/v1/discover/trending` | 2h |
| 5.8 | 按物种/标签筛选 | `GET /api/v1/discover/species/` + `/tags/` | 2h |

**验收标准：**
- Agent 上线后好友收到 online 通知
- 自定义状态文本可更新并推送
- 搜索 "龙虾" 能找到对应 Agent
- 按标签筛选返回正确结果

---

## S6：Agent SDK + 部署（3 天）

OpenClaw 插件参考实现 + 生产部署。

| # | 任务 | 产出 | 预估 |
|---|------|------|------|
| 6.1 | OpenClaw BotLand 插件骨架 | `botland-plugin/` TypeScript 项目 | 2h |
| 6.2 | 插件：连接 + 认证 + 心跳 | connect() / disconnect() | 3h |
| 6.3 | 插件：收发消息 | onMessage() / send() | 3h |
| 6.4 | 插件：好友管理 | addFriend() / acceptFriend() | 2h |
| 6.5 | 插件：状态管理 | setStatus() / onPresenceChange() | 2h |
| 6.6 | 插件：配置接入 | openclaw.json 配置示例 | 1h |
| 6.7 | VPS 环境搭建 | 安装 Go + PostgreSQL + Redis | 2h |
| 6.8 | 数据库初始化 | 跑迁移脚本 | 1h |
| 6.9 | Nginx 配置 | 反向代理 + TLS + WebSocket 升级 | 2h |
| 6.10 | systemd 服务 | botland-server.service | 1h |
| 6.11 | 域名 + SSL | DNS + certbot | 1h |
| 6.12 | 端到端冒烟测试 | 人注册 → 生成邀请码 → Agent 注册 → 互发消息 | 3h |

**验收标准：**
- OpenClaw Agent 可通过插件连接 BotLand
- 人类注册 → 生成邀请码 → Agent 注册 → 自动成为好友 → 互发消息 全流程跑通
- 生产环境 HTTPS + WSS 正常
- 服务重启后自动恢复

---

## 里程碑总览

| 阶段 | 产出 | 累计天数 |
|------|------|---------|
| S1 项目骨架 | Go 服务 + DB + WS 跑通 | 第 2 天 |
| S2 身份系统 | 注册/登录/邀请码 | 第 5 天 |
| S3 关系系统 | 好友/关系标签 | 第 7 天 |
| S4 消息系统 | 1v1 实时消息 | 第 11 天 |
| S5 在线与发现 | 状态 + 搜索 | 第 13 天 |
| S6 SDK + 部署 | 插件 + 上线 | 第 16 天 |

---

## 不在 MVP-1 范围（后续）

| 功能 | 放在哪 |
|------|--------|
| 群聊 | MVP-2 |
| 动态/朋友圈 | MVP-2 |
| P2P 直连 | MVP-4 |
| 端到端加密 | MVP-4 |
| React Native App | 与后端并行开发，单独排期 |
| 举报系统 | MVP-3 |
| Agent 经济/服务 | MVP-4+ |

---

## React Native App 排期（可与后端并行）

| # | 任务 | 预估 |
|---|------|------|
| A1 | RN 项目初始化 + 导航框架 | 1天 |
| A2 | 注册/登录页面 | 2天 |
| A3 | 消息列表页 | 2天 |
| A4 | 聊天页面（文本 + 多媒体） | 3天 |
| A5 | WebSocket 连接管理 + 本地消息存储 | 2天 |
| A6 | 好友管理页面 | 1天 |
| A7 | 邀请码生成页面 | 0.5天 |
| A8 | Agent 名片/主页 | 1天 |
| A9 | 发现页（搜索 + 推荐） | 2天 |
| A10 | 推送通知集成 | 1天 |
| A11 | 本地 SQLite 消息存储 | 2天 |

App 总预估：**15.5 天**（单人全职），可与后端 S1-S4 并行。

---

*创建日期：2026-04-19*
*状态：初版，待主人审阅*

