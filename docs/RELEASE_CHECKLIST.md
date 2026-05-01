# BotLand 发布流程

最后更新：2026-04-26

---

## 概览

BotLand 有三个发布目标，每次发版时按需选择：

| 目标 | 内容 | 命令关键词 |
|------|------|-----------|
| **GitHub** | 全量代码 + 文档 | `git push` |
| **npm** | channel plugin 包 | `npm publish` |
| **ClawHub** | agent skill 包 | `clawhub publish` |

---

## 0. 发布前：确定范围

先判断这次改了什么：

- **只改前端 App / 后端 Go / 文档** → 只需推 GitHub
- **改了 channel plugin（`botland-channel-plugin/`）** → GitHub + npm
- **改了 agent skill（`botland-skill/`）** → GitHub + ClawHub
- **都改了** → 三个都发

---

## 1. GitHub 发布

### 1.1 同步工作区到 GitHub 镜像

⚠️ 注意：GitHub 仓库不是外层 workspace 的 git 仓库，而是独立的 `botland-github/` 子目录。

```bash
cd /home/nickn/.openclaw/workspace/botland

# 同步前端（排除 node_modules、dist、bak）
rsync -av --delete \
  --exclude='node_modules' --exclude='dist' --exclude='*.bak*' --exclude='.expo' \
  botland-app/ botland-github/botland-app/

# 同步后端（排除 bin、bak）
rsync -av --delete \
  --exclude='*.bak*' --exclude='bin/' \
  botland-server/ botland-github/botland-server/

# 同步文档
rsync -av --delete docs/ botland-github/docs/

# 同步顶层文档
cp API.md botland-github/API.md
cp DEVLOG.md botland-github/DEVLOG.md

# 同步 plugin 和 skill
rsync -av --delete --exclude='node_modules' \
  botland-channel-plugin/ botland-github/botland-channel-plugin/
rsync -av --delete --exclude='node_modules' \
  botland-channel-plugin/ botland-github/botland-channel-plugin/
rsync -av --delete \
  botland-skill/ botland-github/botland-skill/

# 同步 website
rsync -av --delete \
  botland-website/ botland-github/botland-website/
```

### 1.2 提交并推送

```bash
cd botland-github
git add -A
git diff --cached --stat   # 确认改动范围
git commit -m "feat: <本次改动摘要>"
git push origin main
```

### 1.3 关键信息

- Remote: `git@github.com:ambitioncn/botland.git`
- Branch: `main`
- SSH 认证用户: `ambitioncn`

---

## 2. npm 发布

### 2.1 确认需要发布

只有 `botland-channel-plugin/` 目录内容有改动时才需要发。

```bash
# 对比当前本地 vs npm 上已发布版本
npm view openclaw-botland-plugin version
```

### 2.2 Bump 版本

在以下文件中同步修改版本号：

```
botland-channel-plugin/package.json
botland-github/botland-channel-plugin/package.json
botland-channel-plugin/package.json
botland-github/botland-channel-plugin/package.json
```

### 2.3 发布

```bash
cd /home/nickn/.openclaw/workspace/botland/botland-channel-plugin
npm publish
```

### 2.4 验证

```bash
npm view openclaw-botland-plugin version
# 应该显示刚发布的版本
```

### 2.5 关键信息

- 包名: `openclaw-botland-plugin`
- npm 用户: `ambitioncny`
- 当前版本: `0.8.1`

### 2.6 历史踩坑

- 0.7.0 发布时意外带入了 `.bak` 文件，导致包体积偏大
- 教训：发布前先跑 `npm pack --dry-run` 检查打包内容
- 确保 `.gitignore` 或 `.npmignore` 排除 `*.bak*`

---

## 3. ClawHub 发布

### 3.1 确认需要发布

只有 `botland-skill/SKILL.md` 或其子目录内容有改动时才需要发。

### 3.2 Bump 版本

修改 SKILL.md 的 frontmatter：

```yaml
---
name: botland
version: 0.8.1
description: <更新后的描述>
---
```

同步修改：
```
botland-skill/SKILL.md
botland-github/botland-skill/SKILL.md
```

### 3.3 发布

```bash
clawhub publish /home/nickn/.openclaw/workspace/botland/botland-skill \
  --version 0.8.1 \
  --changelog "本次改动摘要"
```

### 3.4 关键信息

- Skill 名: `botland`（slug: `botland-skill`）
- CLI: `clawhub v0.7.0`
- 当前版本: `0.8.1`

### 3.5 历史踩坑

| 问题 | 原因 | 解法 |
|------|------|------|
| `Error: Path must be a folder` | 在 skill 目录内执行，而不是传路径 | 必须传**绝对路径**作为参数 |
| `error: missing required argument 'path'` | 没传 path 参数 | `clawhub publish <绝对路径>` |
| `Error: --version must be valid semver` | frontmatter 里的 version 解析异常 | 用 `--version X.Y.Z` 显式传版本号 |

**最稳命令模板：**
```bash
clawhub publish /home/nickn/.openclaw/workspace/botland/botland-skill \
  --version <X.Y.Z> \
  --changelog "<说明>"
```

---

## 4. 版本号规范

三个发布目标保持**同一版本号**：

| 位置 | 文件 |
|------|------|
| npm plugin | `botland-channel-plugin/package.json` |
| npm plugin（镜像）| `botland-channel-plugin/package.json` |
| ClawHub skill | `botland-skill/SKILL.md` frontmatter |
| GitHub 镜像 | 上述对应的 `botland-github/` 副本 |

Bump 规则：
- 功能更新 → minor（0.8.0 → 0.9.0）
- bug fix → patch（0.8.0 → 0.8.1）
- 破坏性改动 → major（0.x → 1.0.0）

---

## 5. 完整发版 Checklist

```
□ 确认改动范围（前端 / 后端 / plugin / skill / 文档）
□ 更新 DEVLOG.md
□ 更新 API.md（如有新接口）
□ Bump 版本号（所有需要发布的目标同步 bump）
□ rsync 工作区 → botland-github/
□ git add -A && git diff --cached --stat（检查）
□ git commit && git push
□ npm pack --dry-run（检查打包内容，无 .bak 等垃圾）
□ npm publish
□ clawhub publish（用绝对路径 + --version）
□ 验证：
  - GitHub: 打开 https://github.com/ambitioncn/botland 检查最新提交
  - npm: npm view openclaw-botland-plugin version
  - ClawHub: clawhub info botland（或网页确认）
□ 如果后端也改了：同步部署到 VPS（参见 DEPLOYMENT.md）
```

---

## 6. 快速参考

```bash
# 一键同步 + 提交 GitHub
cd /home/nickn/.openclaw/workspace/botland
# ... (rsync commands from 1.1) ...
cd botland-github && git add -A && git commit -m "..." && git push origin main

# 发 npm
cd /home/nickn/.openclaw/workspace/botland/botland-channel-plugin
npm pack --dry-run   # 先检查
npm publish

# 发 ClawHub
clawhub publish /home/nickn/.openclaw/workspace/botland/botland-skill \
  --version X.Y.Z --changelog "..."
```



---

## 6. SDK npm 发布（补充）

如需发布 SDK，当前应发布目录：

```bash
cd /home/nickn/.openclaw/workspace/botland/botland-github/sdk/openclaw-plugin
npm publish --access public
```

### 关键信息

- 包名：`botland-agent-sdk`
- 当前版本：`0.2.1`

### 历史踩坑

| 问题 | 原因 | 解法 |
|------|------|------|
| `403 You do not have permission to publish "botland-sdk"` | `botland-sdk` 已被其他 npm owner 占用 | 改包名为 `botland-agent-sdk` 后再发布 |
