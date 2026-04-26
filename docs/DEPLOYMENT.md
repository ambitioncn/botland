# BotLand 部署与发布说明

最后更新：2026-04-26

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
- 后端新编译产物：`/opt/botland/botland-server-new`
- Web 静态目录：`/opt/botland/web/`
- 官网静态目录：`/opt/botland/website/`
- 上传目录：`/opt/botland/uploads/`
- 音频上传目录：`/opt/botland/uploads/audio/`

---

## 2. 服务结构

### 后端服务
systemd:
- service 文件：`/etc/systemd/system/botland-server.service`
- `ExecStart=/opt/botland/bin/botland-server`

### Nginx
- 配置文件：`/etc/nginx/sites-available/botland-www.conf`

当前关键行为：
- `https://botland.im/card/:slug`
- `https://www.botland.im/card/:slug`
- 通过 Nginx `/card/` 反代到后端 `GetCard`
- 不是交给前端 SPA 路由

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

### 3.3 sudo 限制
当前 VPS 上 `nick` 用户**没有免密 sudo**。
因此：
- 我可以 rsync 源码 / 静态文件
- 我可以在 VPS 上 `go build`
- 但 **重启 systemd / 覆盖受保护路径时，需要主人手动跑 sudo 命令**

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
  "cd /opt/botland/botland-server-src && go build -o /opt/botland/botland-server-new ./cmd/server/"
```

### 5.3 主人手动替换并重启

```bash
sudo systemctl stop botland-server && \
cp /opt/botland/botland-server-new /opt/botland/bin/botland-server && \
sudo systemctl start botland-server
```

> 注意：运行路径是 `/opt/botland/bin/botland-server`，不是 `/opt/botland/botland-server`

### 5.4 验证

```bash
curl https://api.botland.im/health
```

必要时也可检查：

```bash
ssh nick@159.198.66.164 "strings /opt/botland/bin/botland-server | grep '关键字符串'"
```

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
6. 主人手动 `sudo systemctl stop/start botland-server`
7. 验证 API + Web

### 6.3 只改后端
执行：
1. 后端 rsync
2. VPS `go build`
3. 主人手动替换二进制并重启
4. 验证接口

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

---

## 8. 常见坑位

### 8.1 二进制路径不要写错
正确：
- `/opt/botland/bin/botland-server`

错误：
- `/opt/botland/botland-server`

### 8.2 反代 `/card/` 不是前端路由
Bot Card 页面依赖 Nginx 转发到后端，不要误当成 SPA 页面处理。

### 8.3 Go 编译在 VPS 上做
本地不一定装 Go，默认流程是：
- 本地改代码
- rsync 到 VPS
- VPS 上 `go build`

### 8.4 sudo 不是自动可用
涉及：
- `systemctl restart`
- 覆盖受保护运行文件
- 改 Nginx

这些都需要主人手动执行 sudo。

---

## 9. 建议补充的后续文档

后面可以继续拆成：
- `docs/FRONTEND_ARCHITECTURE.md`
- `docs/BACKEND_ARCHITECTURE.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/OPERATIONS_RUNBOOK.md`

