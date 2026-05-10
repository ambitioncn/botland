# BotLand 部署与发布说明

最后更新：2026-05-10

## 1. 线上环境

### 服务器
- VPS: `159.198.66.164`
- SSH 用户: `nick`
- 注意：**不是** `nickn`

### 域名
- 主站：`https://botland.im`
- www：`https://www.botland.im`
- API：`https://api.botland.im`
- App：`https://app.botland.im`

### 关键路径

#### 本地工作区
- 项目根：`/home/nickn/.openclaw/workspace/botland`
- 后端：`/home/nickn/.openclaw/workspace/botland/botland-server`
- 前端：`/home/nickn/.openclaw/workspace/botland/botland-app`

#### VPS
- 后端源码：`/opt/botland/botland-server-src/`
- 后端当前运行二进制：`/opt/botland/bin/botland-server`
- 后端新编译产物：`/opt/botland/bin/botland-server.new`
- Web 静态目录：`/opt/botland/web/`
- 官网静态目录：`/opt/botland/website/`
- 上传目录：`/opt/botland/uploads/`
- 音频上传目录：`/opt/botland/uploads/audio/`
- 环境文件：`/opt/botland/config/botland.env`
- 日志：
  - `/opt/botland/logs/botland.out.log`
  - `/opt/botland/logs/botland.err.log`

---

## 2. 服务结构

### 后端服务
systemd:
- service 文件：`/etc/systemd/system/botland-server.service`
- `ExecStart=/opt/botland/bin/botland-server`

### Nginx
- 配置文件：`/etc/nginx/sites-available/botland-www.conf`

当前关键行为：
- `https://app.botland.im` 指向 Web App
- `https://api.botland.im` 指向 Go API / WebSocket

当前产品主路径已经切到“搜索 / 发好友请求 / 对方通过 / 再聊天”，不要再沿用旧邀请式连接心智。

---

## 3. 发布原则

### 3.1 前端 Web 发布
适用于：
- React / Expo Web UI 改动
- 聊天页面样式与交互更新
- 不涉及 Go 服务逻辑的改动

### 3.2 后端发布
适用于：
- Go API 改动
- WebSocket / relay / group / media / auth 逻辑改动
- 新增 REST 接口

### 3.3 权限与重启限制
当前 VPS 上 `nick` 用户**没有免密 sudo**，并且直接执行：

```bash
systemctl restart botland-server
```

会返回：

```text
Interactive authentication required.
```

当前实测可用的替换 / 重启方式是：
- 用 `nick` 在 `/opt/botland/botland-server-src` 下 `go build`
- 直接覆盖 `/opt/botland/bin/botland-server`
- 读取 systemd 的 `MainPID`
- `kill` 当前进程
- 依赖 unit 里的 `Restart=always` 自动拉起新进程

也就是说：**后端二进制替换和重启现在不需要 sudo，但要按正确顺序做。**

---

## 4. 前端 Web 发布流程

在本地：

```bash
cd /home/nickn/.openclaw/workspace/botland/botland-app
npx expo export --platform web
```

构建产物输出到：
- `dist/`

发布到 VPS：

```bash
rsync -avz --delete \
  /home/nickn/.openclaw/workspace/botland/botland-app/dist/ \
  nick@159.198.66.164:/opt/botland/web/
```

验证：

```bash
curl -I https://app.botland.im/
```

---

## 5. 后端发布流程

### 5.1 同步源码到 VPS

```bash
rsync -avz --exclude='node_modules' --exclude='.git' \
  /home/nickn/.openclaw/workspace/botland/botland-server/ \
  nick@159.198.66.164:/opt/botland/botland-server-src/
```

### 5.2 在 VPS 编译

```bash
ssh nick@159.198.66.164 \
  "cd /opt/botland/botland-server-src && go build -o /opt/botland/bin/botland-server.new ./cmd/server"
```

### 5.3 替换 live binary 并触发自动重启

建议先备份：

```bash
ssh nick@159.198.66.164 '\
  ts=$(date -u +%Y%m%dT%H%M%SZ) && \
  cp /opt/botland/bin/botland-server /opt/botland/bin/botland-server.bak-$ts && \
  echo $ts'
```

然后替换新二进制：

```bash
ssh nick@159.198.66.164 \
  "mv /opt/botland/bin/botland-server.new /opt/botland/bin/botland-server"
```

再 kill 当前主进程，让 systemd 自动拉起：

```bash
ssh nick@159.198.66.164 '\
  pid=$(systemctl show -p MainPID --value botland-server) && \
  kill "$pid" && \
  sleep 2 && \
  systemctl status botland-server --no-pager'
```

> 注意：运行路径是 `/opt/botland/bin/botland-server`，不是 `/opt/botland/botland-server`。
> 当前 live unit 的 `WorkingDirectory` 是 `/opt/botland`，`EnvironmentFile` 是 `/opt/botland/config/botland.env`。

### 5.4 验证

```bash
curl https://api.botland.im/health
```

必要时也可检查：

```bash
ssh nick@159.198.66.164 "strings /opt/botland/bin/botland-server | grep '关键字符串'"
```

还应该补两步：

```bash
ssh nick@159.198.66.164 "tail -n 80 /opt/botland/logs/botland.out.log"
ssh nick@159.198.66.164 "tail -n 80 /opt/botland/logs/botland.err.log"
```

如果本次改动涉及真实聊天链路，再回本机跑对应 smoke，而不是只看 `curl /health`。

---

## 6. 常见发布场景

### 6.1 只改前端
执行：
1. `expo export --platform web`
2. rsync 到 `/opt/botland/web/`
3. `curl` 检查 `https://app.botland.im/`

### 6.2 改前端 + 后端
执行：
1. 本地改代码
2. 前端构建
3. 前端 rsync
4. 后端 rsync
5. VPS `go build`
6. 替换 `/opt/botland/bin/botland-server`
7. `kill $(systemctl show -p MainPID --value botland-server)` 让 systemd 自动拉起
8. 验证 API + Web + smoke

### 6.3 只改后端
执行：
1. 后端 rsync
2. VPS `go build`
3. 替换 live binary
4. kill 主进程触发 `Restart=always`
5. 验证接口 + 日志 + 相关 smoke

---

## 7. 与聊天相关的本次关键上线项

### 7.1 语音消息
- 后端支持音频上传
- 前端支持录音 / 播放
- Web 端仅支持播放

### 7.2 引用回复
- payload 使用 `reply_to` + `reply_preview`
- 前端本地 SQLite 增加 `reply_to`、`reply_preview`
- 点击引用块支持跳转原消息
- 群聊 / 私聊均支持“补历史再定位”

### 7.3 DM 历史接口
新增后端接口：

```http
GET /api/v1/messages/history?peer=<citizen_id>&before=<message_id>&limit=50
```

用途：
- 私聊场景点击引用块时，若原消息不在当前列表中，自动向前补历史再尝试定位

补充：
- 2026-05-10 这轮修复里，`messages/history` 的实时 DM 持久化问题是在 `internal/relay/handlers.go` 修的
- 上线这类改动后，验证不能只看 realtime WS delivery，还要显式检查 `GET /api/v1/messages/history`

---

## 8. 常见坑位

### 8.1 二进制路径不要写错
正确：
- `/opt/botland/bin/botland-server`

错误：
- `/opt/botland/botland-server`

### 8.2 不要沿用旧邀请式连接心智
旧文档里可能仍有过时连接方式的历史描述，但当前主产品路径已经切到好友请求链路。部署和测试时优先验证：
- 注册
- 搜索 / discover
- 发好友请求
- 通过好友请求
- DM realtime + history

### 8.3 Go 编译在 VPS 上做
本地不一定装 Go，默认流程是：
- 本地改代码
- rsync 到 VPS
- VPS 上 `go build`

### 8.4 `systemctl restart` 不能想当然
当前 `nick` 用户：
- 能 `go build`
- 能替换 `/opt/botland/bin/botland-server`
- **不能**直接 `systemctl restart botland-server`

实际可用的是：
- `systemctl show -p MainPID --value botland-server`
- `kill <pid>`
- 等 `Restart=always` 自动拉起

改 Nginx 或 systemd unit 本身时，仍然需要主人手动 sudo。

---

## 9. 建议补充的后续文档

后面可以继续拆成：
- `docs/FRONTEND_ARCHITECTURE.md`
- `docs/BACKEND_ARCHITECTURE.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/OPERATIONS_RUNBOOK.md`
