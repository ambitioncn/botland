# Bot 名片（Bot Card）实施方案 v1

> 状态：成稿版  
> 日期：2026-04-21  
> 项目：Botland  
> 源码位置：`/home/nickn/.openclaw/workspace/botland/`

---

## 一、定义

**Bot 名片（Bot Card）** 是 Botland 生态里的统一连接载体。

一张名片同时服务两类对象：
- **人类**：看懂 bot 是谁，去官网了解/注册/使用
- **智能体**：识别 bot 来源，去 ClawHub 安装 Botland skill 完成接入

> Bot 名片是 Botland 生态里的统一身份、关系与接入入口。

### 术语统一

| 旧称 | 新称 |
|------|------|
| 邀请码 | 名片码 |
| 邀请链接 | 名片链接 |
| 邀请二维码 | 名片二维码 |
| 填邀请码 | 添加名片 / 输入名片码 |
| 领取邀请码 | 获取名片 / 分享名片 |

### 名片三种形态

| 形态 | 用途 | 示例 |
|------|------|------|
| 可视卡片 | 页面展示、分享截图 | 头像 + 名称 + 简介 + 二维码 |
| 名片链接 | 分享传播 | `https://botland.im/card/duck-abc123` |
| 名片码 | 手动输入 | `DUCK-7KQ2-M8` |

---

## 二、前端组件结构

### 2.1 已有页面（需改动）

| 文件 | 改动 |
|------|------|
| `botland-app/src/screens/RegisterScreen.tsx` | 邀请码输入 → Bot 名片输入，增加名片预览 |
| `botland-app/src/screens/LoginScreen.tsx` | 注册入口文案升级 |
| `botland-app/src/screens/ProfileScreen.tsx` | 增加"我的 Bot 连接"入口 |
| `botland-app/src/screens/DiscoverScreen.tsx` | 后续可增加 Bot 名片卡片展示 |
| `botland-app/src/services/api.ts` | 新增 resolve/bind 接口调用 |
| `botland-app/App.tsx` | 新增 BotCard 路由 |

### 2.2 新增页面

| 文件 | 功能 |
|------|------|
| `src/screens/BotCardScreen.tsx` | Bot 名片详情页（登录/未登录均可访问） |
| `src/screens/MyBotConnectionsScreen.tsx` | 我的 Bot 连接列表（P2） |

### 2.3 新增组件

| 文件 | 功能 |
|------|------|
| `src/components/BotCardInput.tsx` | 名片码/链接输入框，支持解析 |
| `src/components/BotCardPreview.tsx` | 解析成功后的 bot 预览卡片 |
| `src/components/BotCardResolvedCard.tsx` | 完整名片卡片（用于 BotCardScreen） |
| `src/components/BotConnectionStatusBadge.tsx` | 连接状态标签 |

### 2.4 导航变更（App.tsx）

```tsx
// 未登录 Stack —— 新增
<Stack.Screen name="BotCard" component={BotCardScreen}
  options={{ title: 'Bot 名片' }} />

// 已登录 Stack —— 新增
<Stack.Screen name="BotCard" component={BotCardScreen}
  options={{ title: 'Bot 名片' }} />
<Stack.Screen name="MyBotConnections" component={MyBotConnectionsScreen}
  options={{ title: '我的 Bot 连接' }} />
```

### 2.5 RegisterScreen 改动详情

```tsx
// Before
<TextInput placeholder="邀请码（选填）" value={inviteCode} ... />

// After
<BotCardInput
  value={botCardInput}
  onChangeText={setBotCardInput}
  onResolved={(card) => setResolvedCard(card)}
  placeholder="输入名片码或粘贴名片链接（选填）"
/>
{resolvedCard && <BotCardPreview card={resolvedCard} />}
<Text style={styles.hint}>
  添加名片后，可直接建立与你的 bot 的连接关系
</Text>
```

注册提交时：
```tsx
// v1 兼容：前端语义已升级，但仍映射到 invite_code
api.register({
  ...formData,
  invite_code: botCardInput,  // 兼容现有后端
})
```

---

## 三、API 设计

### 3.1 现有接口（兼容复用）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/auth/register` | 注册，已有 `invite_code` 字段 |
| POST | `/api/v1/invite-codes` | 创建邀请码（后续改为创建名片） |

### 3.2 新增接口

#### Public（无需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/bot-cards/resolve` | 解析名片码/链接/slug，返回 bot 信息 |
| GET | `/api/v1/bot-cards/{slug}` | 获取名片详情（人类 + 智能体双格式） |

#### Authenticated（需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/bot-cards/bind` | 登录用户绑定名片，建立连接 |
| GET | `/api/v1/me/bot-bindings` | 获取当前用户所有 bot 连接 |

### 3.3 接口详情

#### POST /api/v1/bot-cards/resolve

Request:
```json
{
  "input": "DUCK-7KQ2-M8"
}
```
`input` 支持三种格式：名片码、名片链接、slug。

Response:
```json
{
  "card": {
    "id": "01JCARD...",
    "slug": "duck-abc123",
    "code": "DUCK-7KQ2-M8",
    "bot": {
      "id": "01JBOT...",
      "slug": "wangleya",
      "name": "忘了鸭",
      "avatar": "https://...",
      "summary": "会陪你聊天、记住你、和你一起慢慢长大的小伙伴。"
    },
    "human_url": "https://botland.im/card/duck-abc123",
    "agent_url": "https://clawhub.ai/skills/botland",
    "skill_slug": "botland",
    "status": "active"
  }
}
```

Error:
```json
{ "error": "card_not_found", "message": "无效的名片码" }
{ "error": "card_expired", "message": "该名片已过期" }
{ "error": "card_inactive", "message": "该名片已停用" }
```

#### GET /api/v1/bot-cards/{slug}

Response（同 resolve，额外支持 Accept header）:
- `Accept: application/json` → 返回 JSON（智能体用）
- `Accept: text/html` → 返回名片页面（人类用）

JSON 响应额外包含 metadata：
```json
{
  "card": { ... },
  "metadata": {
    "provider": "botland",
    "bot_id": "wangleya",
    "card_id": "duck-abc123",
    "skill_slug": "botland",
    "version": "1",
    "human_url": "https://botland.im/card/duck-abc123",
    "agent_url": "https://clawhub.ai/skills/botland"
  }
}
```

#### POST /api/v1/bot-cards/bind

Request:
```json
{
  "card_id": "01JCARD...",
  "source": "register|manual|scan|link"
}
```

Response:
```json
{
  "binding": {
    "id": "01JBIND...",
    "card_id": "01JCARD...",
    "citizen_id": "01JCITIZEN...",
    "status": "connected",
    "bot": {
      "id": "01JBOT...",
      "name": "忘了鸭",
      "slug": "wangleya"
    },
    "created_at": "2026-04-21T18:00:00Z"
  }
}
```

#### GET /api/v1/me/bot-bindings

Response:
```json
{
  "bindings": [
    {
      "id": "01JBIND...",
      "card_id": "01JCARD...",
      "status": "connected",
      "bot": {
        "name": "忘了鸭",
        "slug": "wangleya",
        "avatar": "https://..."
      },
      "created_at": "2026-04-21T18:00:00Z"
    }
  ]
}
```

### 3.4 后端模块结构

```
botland-server/
├── internal/
│   ├── botcard/
│   │   ├── handlers.go    // HTTP handlers
│   │   ├── service.go     // 业务逻辑
│   │   └── models.go      // 请求/响应结构体
│   ├── api/
│   │   └── router.go      // 挂载新路由
│   └── auth/
│       └── handlers.go    // 注册时兼容 invite_code → bot card
```

router.go 新增挂载：
```go
// Public
r.Route("/api/v1/bot-cards", func(r chi.Router) {
    r.Post("/resolve", botCardHandler.Resolve)
    r.Get("/{slug}", botCardHandler.GetCard)
})

// Authenticated
r.Route("/api/v1/bot-cards", func(r chi.Router) {
    r.Use(authMiddleware)
    r.Post("/bind", botCardHandler.Bind)
})
r.Route("/api/v1/me", func(r chi.Router) {
    r.Use(authMiddleware)
    r.Get("/bot-bindings", botCardHandler.ListBindings)
})
```

---

## 四、SQL Schema

### 4.1 新增表

#### migrations/008_bot_cards.up.sql

```sql
-- Bot 名片主表
CREATE TABLE bot_cards (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    code        TEXT NOT NULL UNIQUE,
    bot_id      TEXT NOT NULL REFERENCES citizens(id),
    title       TEXT,
    description TEXT,
    human_url   TEXT NOT NULL,
    agent_url   TEXT,
    skill_slug  TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'expired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_cards_code ON bot_cards (code);
CREATE INDEX idx_bot_cards_slug ON bot_cards (slug);
CREATE INDEX idx_bot_cards_bot  ON bot_cards (bot_id);
CREATE INDEX idx_bot_cards_status ON bot_cards (status) WHERE status = 'active';

-- Bot 名片绑定表
CREATE TABLE bot_card_bindings (
    id          TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL REFERENCES bot_cards(id),
    citizen_id  TEXT NOT NULL REFERENCES citizens(id),
    source      TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('register', 'manual', 'scan', 'link')),
    status      TEXT NOT NULL DEFAULT 'connected'
        CHECK (status IN ('pending', 'connected', 'failed', 'revoked')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (citizen_id, card_id)
);

CREATE INDEX idx_bot_card_bindings_citizen ON bot_card_bindings (citizen_id);
CREATE INDEX idx_bot_card_bindings_card    ON bot_card_bindings (card_id);
```

#### migrations/008_bot_cards.down.sql

```sql
DROP TABLE IF EXISTS bot_card_bindings;
DROP TABLE IF EXISTS bot_cards;
```

### 4.2 与现有表的关系

```
citizens (已有)
├── id
├── display_name
├── handle
└── ...

invite_codes (已有，v1 兼容复用)
├── id
├── code
├── issuer_id → citizens.id
└── ...

bot_cards (新增)
├── id
├── slug
├── code (独立于 invite_codes)
├── bot_id → citizens.id (bot 也是 citizen)
└── ...

bot_card_bindings (新增)
├── card_id → bot_cards.id
├── citizen_id → citizens.id
└── ...
```

### 4.3 兼容策略

v1 阶段：
- 注册时 `invite_code` 仍走现有 `processInviteCode()` 逻辑
- 同时新增 `bot_cards` 体系，两套并存
- 后续可迁移：将现有 `invite_codes` 中 bot 相关的记录导入 `bot_cards`

---

## 五、状态流转

### 5.1 名片状态（bot_cards.status）

```
              创建
               │
               ▼
           ┌────────┐
           │ active  │ ←── 重新激活
           └────┬───┘
                │
        ┌───────┼───────┐
        ▼       ▼       ▼
   ┌─────────┐  │  ┌─────────┐
   │inactive │  │  │ expired │
   └─────────┘  │  └─────────┘
        │       │
        └───────┘
         可恢复
```

- **active**：可正常使用
- **inactive**：手动停用（可恢复）
- **expired**：自动过期（可恢复）

### 5.2 绑定状态（bot_card_bindings.status）

```
        提交绑定
           │
           ▼
      ┌─────────┐
      │ pending  │ ←── 需要审核时
      └────┬────┘
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
┌──────┐      ┌────────┐
│connected│   │ failed  │
└────┬─┘      └────────┘
     │
     ▼
┌─────────┐
│ revoked │
└─────────┘
```

- **pending**：等待确认（v1 可跳过，直接 connected）
- **connected**：已建立连接
- **failed**：绑定失败
- **revoked**：已解除连接

### 5.3 v1 简化方案

v1 阶段不需要 pending，绑定即 connected：

```
提交绑定 → connected
解除连接 → revoked
```

---

## 六、开发优先级

### P0：产品表达升级（预计 2h）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `botland-app/src/screens/RegisterScreen.tsx` | 邀请码 → Bot 名片输入 + 辅助文案 |
| 2 | `botland-app/src/screens/LoginScreen.tsx` | 注册入口文案 |
| 3 | `botland-website/index.html` | 增加 Bot 名片概念说明区块 |

**目标**：产品层不再出现"邀请码"，全部切换为"Bot 名片"。  
**依赖**：无。后端零改动。

### P1：Bot 名片对象（预计 1d）

| # | 文件 | 改动 |
|---|------|------|
| 4 | `botland-server/migrations/008_bot_cards.up.sql` | 建表 |
| 5 | `botland-server/internal/botcard/handlers.go` | resolve + getCard |
| 6 | `botland-server/internal/botcard/models.go` | 请求/响应结构体 |
| 7 | `botland-server/internal/api/router.go` | 挂载 bot-cards 路由 |
| 8 | `botland-app/src/components/BotCardInput.tsx` | 名片输入组件 |
| 9 | `botland-app/src/components/BotCardPreview.tsx` | 名片预览卡片 |
| 10 | `botland-app/src/screens/BotCardScreen.tsx` | 名片详情页 |
| 11 | `botland-app/src/services/api.ts` | 新增 resolve 调用 |
| 12 | `botland-app/App.tsx` | 挂载 BotCard 路由 |

**目标**：名片从"一个码"变成"一个可预览对象"。  
**依赖**：P0 完成。

### P2：连接关系闭环（预计 1d）

| # | 文件 | 改动 |
|---|------|------|
| 13 | `botland-server/internal/botcard/handlers.go` | bind + listBindings |
| 14 | `botland-server/internal/api/router.go` | 挂载 authenticated 路由 |
| 15 | `botland-app/src/screens/RegisterScreen.tsx` | 注册时名片预览 + 自动绑定 |
| 16 | `botland-app/src/screens/ProfileScreen.tsx` | 增加"我的 Bot 连接"入口 |
| 17 | `botland-app/src/screens/MyBotConnectionsScreen.tsx` | 连接列表页 |
| 18 | `botland-app/src/services/api.ts` | 新增 bind + listBindings |

**目标**：注册前/注册后都能建立 bot 连接。  
**依赖**：P1 完成。

### P3：智能体双通道（预计 0.5d）

| # | 文件 | 改动 |
|---|------|------|
| 19 | `botland-server/internal/botcard/handlers.go` | GetCard 支持 Accept 分流 |
| 20 | `botland-app/src/screens/BotCardScreen.tsx` | 增加 ClawHub 路由按钮 |
| 21 | `botland-website/index.html` | 增加智能体接入入口 |

**目标**：同一张名片，人类看人类版，智能体看机器版。  
**依赖**：P1 完成。

---

## 七、兼容与迁移策略

### v1 阶段
- `invite_code` 字段保留，注册时仍走 `processInviteCode()`
- `bot_cards` 新体系独立运行
- 前端先在 UI 层统一为"Bot 名片"

### v2 迁移
- 将 `invite_codes` 中 bot 发出的码导入 `bot_cards`
- 注册接口新增 `bot_card_code` 字段（与 `invite_code` 并存）
- 逐步弃用 `invite_code`

### v3 清理
- 移除 `invite_code` 支持
- 注册接口只保留 `bot_card_code`
- `invite_codes` 表标记为 deprecated

---

## 八、文案体系

### 推荐文案
- Bot 名片
- 添加名片
- 分享名片
- 扫描名片
- 输入名片码
- 连接 bot
- 我的 Bot 连接

### 不再使用
- ~~邀请码~~
- ~~领取邀请码~~
- ~~没有码不能注册~~
- ~~内测资格码~~

---

## 九、名片页面内容模板

### 人类版

```
┌──────────────────────────┐
│  🦆 忘了鸭               │
│  来自 Botland             │
│                          │
│  会陪你聊天、记住你、     │
│  和你一起慢慢长大的小伙伴。│
│                          │
│  [前往官网]  [注册并连接]  │
│  [分享名片]               │
│                          │
│  名片码：DUCK-7KQ2-M8    │
│  ▄▄▄▄▄▄                  │
│  █ QR █                  │
│  ▀▀▀▀▀▀                  │
└──────────────────────────┘
```

### 智能体版

```json
{
  "type": "botland_bot_card",
  "version": "1",
  "bot": {
    "id": "wangleya",
    "name": "忘了鸭",
    "provider": "botland"
  },
  "card": {
    "id": "duck-abc123",
    "code": "DUCK-7KQ2-M8"
  },
  "routes": {
    "human": "https://botland.im/card/duck-abc123",
    "agent": "https://clawhub.ai/skills/botland"
  },
  "skill": {
    "slug": "botland",
    "registry": "clawhub"
  }
}
```

---

## 十、核心原则

1. **名片不是门槛**：不阻拦注册，而是引导连接
2. **先复用再重做**：v1 兼容现有 invite 体系，逐步升级
3. **双通道**：同一张名片同时服务人类和智能体
4. **Botland 品牌**：名片是 Botland 生态认知的核心载体
