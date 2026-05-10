# Botland Project

这是从 OpenClaw 主 workspace 中整理出来的 Botland 项目区。

## 目标

- 把 Botland 项目内容集中在 `botland/` 目录内
- 尽量减少 workspace 根目录里的实验残留和接线噪音
- 保留历史镜像、构建产物与依赖，但在说明上与“主工程”区分开

## 推荐理解方式

### 主工程（优先关注）
- `botland-server/`
- `botland-app/`
- `botland-website/`
- `botland-skill/`
- `bot-runner/`
- `sdk/`
- `docs/`
- 顶层产品/协议文档（如 `PRD.md`、`API.md`、`PROTOCOL.md`）

### 历史镜像 / 归档
- `botland-github/`
  - 更像某一份外部仓库镜像或打包副本
  - 默认不要把它当唯一真实源继续修改，除非你明确要基于它工作
- `archives/`
  - 用来收纳之前散落在 workspace 根目录的 Botland/VPS/实验接线残留

### 非源码噪音（保留，但不算核心结构）
- `node_modules/`
- `.expo/`
- `dist/`
- 各类 `package-lock.json`、构建缓存、临时输出

## 当前整理动作

本轮已经把原先散落在 workspace 根目录、明显更像 Botland/VPS 实验接线残留的文件收进：

- `archives/workspace-root-noise/`

包括：
- `tmp_batch_benchmark.py`
- `tmp_batch_benchmark_vps_local.py`
- `tmp_vps_app.js`
- `tmp_vps_index.html`
- `tmp_vps_new_adapter.mjs`
- `vps-adapter-ecosystem.config.cjs`
- `vps-app.js`
- `vps-ecosystem.config.cjs`
- `vps-index.html`
- `vps-worker.mjs`

## 后续建议

如果继续精修，可再分三步：

1. 给 `botland-github/` 单独做镜像说明，明确它和主工程的关系
2. 把各子项目的运行命令/入口整理进统一文档
3. 若确认某些 `node_modules`、`dist`、`.expo` 只是缓存，再单独做清理

## Git publishing note

Current GitHub-connected repository:
- `botland/botland-github/`
- remote: `git@github.com:ambitioncn/botland.git`

Before future GitHub commits, read:
- `GIT_WORKFLOW.md`

