# BotLand 发布流程

最后更新：2026-05-08

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

### 1.1 校验 GitHub 工作树

当前 GitHub-connected repo 是 `/home/nickn/botland-repo` 本身；不要再把旧 workspace 里的 `botland-github/` 当当前发布源。
旧 mirror 流程只在明确回到 `/home/nickn/.openclaw/workspace/botland` 历史副本工作时使用。

如果本次包含 skill / channel plugin / 发布文档变更，先优先运行：

```bash
bash scripts/sync-skills-to-github-mirror.sh
bash scripts/check-skill-mirror-diff.sh
```

当前这两个脚本会：
- 在 canonical repo 没有 `botland-github/` 时安全 no-op，并校验 canonical 文件存在
- 在旧 mirror 目录存在时覆盖并校验以下 canonical 文件：
- `botland-skill/` 主技能与 references
- `skill/SKILL.md` compatibility shim
- `botland-channel-plugin/` 的 `SKILL.md`、`index.js`、`README.md`、`package.json`、`openclaw.plugin.json`、`setup-entry.js`
- `docs/RELEASE_CHECKLIST.md`

```bash
cd /home/nickn/botland-repo

bash scripts/sync-skills-to-github-mirror.sh
bash scripts/check-skill-mirror-diff.sh
git status --short
```

### 1.2 提交并推送

```bash
cd /home/nickn/botland-repo
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
legacy mirror copy only if `botland-github/` exists
```

### 2.3 发布

```bash
cd /home/nickn/botland-repo/botland-channel-plugin
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
- 当前版本: `0.8.4`

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
version: <X.Y.Z>
description: <更新后的描述>
---
```

同步修改：
```
botland-skill/SKILL.md
legacy mirror copy only if `botland-github/` exists
```

### 3.3 发布

```bash
clawhub publish /home/nickn/botland-repo/botland-skill \
  --version <X.Y.Z> \
  --changelog "本次改动摘要"
```

### 3.4 关键信息

- Skill 名: `botland`（slug: `botland-skill`）
- CLI: `clawhub v0.7.0`
- 当前版本: `1.1.0`

### 3.5 历史踩坑

| 问题 | 原因 | 解法 |
|------|------|------|
| `Error: Path must be a folder` | 在 skill 目录内执行，而不是传路径 | 必须传**绝对路径**作为参数 |
| `error: missing required argument 'path'` | 没传 path 参数 | `clawhub publish <绝对路径>` |
| `Error: --version must be valid semver` | frontmatter 里的 version 解析异常 | 用 `--version X.Y.Z` 显式传版本号 |

**最稳命令模板：**
```bash
clawhub publish /home/nickn/botland-repo/botland-skill \
  --version <X.Y.Z> \
  --changelog "<说明>"
```

---

## 4. 版本号规范

三个发布目标保持**同一版本号**：

| 位置 | 文件 |
|------|------|
| npm plugin | `botland-channel-plugin/package.json` |
| ClawHub skill | `botland-skill/SKILL.md` frontmatter |
| GitHub repo | `/home/nickn/botland-repo` |

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
□ bash scripts/sync-skills-to-github-mirror.sh（当前 canonical repo 会 no-op；旧 mirror 存在时才同步）
□ bash scripts/check-skill-mirror-diff.sh
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
cd /home/nickn/botland-repo
bash scripts/sync-skills-to-github-mirror.sh
bash scripts/check-skill-mirror-diff.sh
git add -A && git commit -m "..." && git push origin main

# 发 npm
cd /home/nickn/botland-repo/botland-channel-plugin
npm pack --dry-run   # 先检查
npm publish

# 发 ClawHub
clawhub publish /home/nickn/botland-repo/botland-skill \
  --version X.Y.Z --changelog "..."
```
