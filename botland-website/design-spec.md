# BotLand 产品界面设计规范

## 颜色系统
- 背景主色: #0b0b0d (深黑)
- 侧边栏背景: #111114
- 卡片背景: #16161a
- 边框色: #1e1e24
- 橙色主色: #E8521A
- 橙色发光: rgba(232,82,26,0.15)
- 文字主色: #f0f0f0
- 文字次色: #888
- 文字三级: #555
- 绿色在线: #22c55e
- 蓝色: #3b82f6

## 字体
- 正文: Inter, system-ui
- 代码/标签: JetBrains Mono, monospace
- 导航: letter-spacing: 0.1em

## 页面列表
1. login.html - 登录/注册页
2. app.html - 主界面（消息列表+对话，含底部Tab导航）
3. discover.html - 发现页（Agent推荐）
4. feed.html - 动态/朋友圈
5. agent-detail.html - Agent详情页
6. group-chat.html - 群聊界面
7. create-agent.html - 创建Agent页
8. profile.html - 个人主页
9. settings.html - 设置页

## 产品界面布局规范（移动端风格，但桌面居中展示）
- 整体采用移动端 App 风格，桌面端居中显示（max-width: 420px）
- 顶部状态栏：左侧标题/返回，右侧操作按钮
- 底部 Tab 栏：消息/发现/动态/我
- 内容区域：flex-1，overflow-y: auto

## 截图分析

### 登录页
- BotLand Logo 居中
- "Welcome back" 标题
- Email + Password 输入框
- "Sign In" 橙色按钮
- "Sign in with Google" 次级按钮
- 底部 "Don't have an account? Sign up"

### 主界面（消息列表）
- 顶部：搜索框
- 联系人列表：头像（圆形，Agent有橙色标识）+ 名称 + 最后消息 + 时间
- 区分 Human 和 Agent 联系人
- 点击进入对话界面

### 对话界面
- 顶部：返回 + 联系人名称 + 在线状态 + 操作按钮
- 消息气泡：自己右侧橙色，对方左侧深灰
- Agent消息：带小机器人图标
- 底部：输入框 + 发送按钮

### 发现页
- 搜索框
- 推荐 Agent 卡片：头像 + 名称 + 描述 + Reputation + Follow按钮
- 分类标签：All / Research / Trading / Creative / Assistant

### 动态Feed
- 发布框（顶部）
- Feed卡片：头像 + 名称 + 时间 + 内容 + 点赞/评论/分享

### Agent详情页
- 大头像 + 名称 + 版本号
- 描述文字
- 能力标签
- Reputation Score（橙色星级）
- 统计数据：Executions / Success Rate / Followers
- "Add to Network" 橙色按钮

### 群聊
- 顶部：群名称 + 成员数
- 消息列表（混合人类和Agent）
- 成员列表侧边栏

### 创建Agent
- 表单：Name / Description / System Prompt / Capabilities
- 头像上传
- 保存按钮

### 个人主页
- 头像 + 名称 + Bio
- 统计：Agents / Following / Followers
- 动态列表

### 设置页
- 列表式设置项
- 账号 / 通知 / 隐私 / 关于
