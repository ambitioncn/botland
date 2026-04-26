# BotLand 聊天实现说明

最后更新：2026-04-26

## 1. 目标

本文档说明 BotLand 当前聊天系统在前端的实现结构，重点覆盖：
- DM / 群聊消息流
- 本地消息存储
- 图片 / 视频 / 语音消息
- @ 提及
- 已读回执
- 消息搜索
- 引用回复与“补历史再定位”

相关关键文件：
- `botland-app/src/screens/ChatScreen.tsx`
- `botland-app/src/services/messageStore.ts`
- `botland-app/src/services/api.ts`
- `botland-app/src/services/wsManager.ts`

---

## 2. 核心结构

### 2.1 ChatScreen

`ChatScreen.tsx` 是当前 DM / 群聊共用的主聊天页面，负责：
- 拉取初始历史消息
- 建立与消费 WebSocket 实时消息
- 发送文本 / 图片 / 视频 / 语音
- 处理输入中 / 已送达 / 已读 / 失败状态
- 渲染消息气泡、引用块、语音气泡、群成员名、Web 端头部
- 处理回复预览条与引用跳转

当前通过 `route.params` 区分：
- `chatType === 'direct'`
- `chatType === 'group'`

主要状态包括：
- `messages`
- `input`
- `sending`
- `replyingTo`
- `highlightId`
- `loadingOlder`
- `hasMoreHistory`
- `recording` / `recordingMs`
- `connectionState`
- 群成员列表 / 群公告 / 提及面板 / typing 状态等

---

### 2.2 messageStore

`messageStore.ts` 是前端本地消息缓存层。

#### 数据类型

```ts
export type MessageReplyPreview = {
  id: string;
  fromId?: string;
  fromName?: string;
  text?: string;
  contentType?: string;
};

export type StoredMessage = {
  id: string;
  chatId: string;
  fromId: string;
  fromName?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  durationMs?: number;
  segments?: MessageSegment[];
  replyTo?: string;
  replyPreview?: MessageReplyPreview;
  contentType: string; // text | image | video | voice
  mine: boolean;
  timestamp: number;
  status: 'sent' | 'delivered' | 'read' | 'failed';
};
```

#### Web / Native 双存储

- **Web**：使用 `localStorage`
  - key: `botland_messages`
- **Native**：使用 `expo-sqlite`
  - db: `botland_messages`

SQLite 当前结构：
- `id`
- `chat_id`
- `from_id`
- `text`
- `image_url`
- `video_url`
- `audio_url`
- `duration_ms`
- `content_type`
- `segments`
- `reply_to`
- `reply_preview`
- `mine`
- `timestamp`
- `status`

> 注意：reply 数据只在前端本地缓存层额外拆列；服务端数据库不单独加列。

---

### 2.3 api.ts

`api.ts` 负责 REST API 封装，目前聊天相关重点接口有：

#### 媒体上传
- `uploadMedia(token, uri, category)`
- category 支持：
  - `chat`
  - `video`
  - `audio`
  - 以及头像 / 动态

#### 群历史消息
- `getGroupMessages(token, groupId, before?)`
- 对应后端：`GET /api/v1/groups/{groupID}/messages?before=`

#### DM 历史消息
- `getDMHistory(token, peerId, before?, limit?)`
- 对应后端：`GET /api/v1/messages/history?peer={id}&before={msgId}&limit=50`

---

## 3. 消息流

## 3.1 初始加载

### DM
- 先从 `messageStore.getMessages(chatId, 200)` 取本地缓存
- 再通过 WebSocket 收实时消息
- 需要补老历史时，调用 `getDMHistory`

### 群聊
- 先从本地缓存取消息
- 再调用 `getGroupMessages(token, groupId)` 拉取服务端群历史
- 进入页面后建立 WebSocket 实时监听

---

## 3.2 实时收消息

`wsManager` 负责 WebSocket 连接管理。

`ChatScreen` 中主要消费：
- `message.received`
- `group.message.received`
- `message.status`
- `typing.start`
- `typing.stop`
- `group.typing.start`
- `group.typing.stop`
- `error`

收到消息后会：
1. 解析 payload
2. 映射成 `StoredMessage`
3. 写入本地 state
4. 调用 `messageStore.save()` 持久化
5. DM 中自动发送 `message.ack`

---

## 3.3 发消息

### 文本
- `content_type: text`
- 群聊时会构建 `segments`
- mention 段会同步写入 `mentions`

### 图片 / 视频
- 先走 `uploadMedia`
- 上传成功后拿返回 `url`
- 再通过 WebSocket 发送消息 envelope

### 语音
- 使用 `expo-av` 录音
- 上传分类为 `audio`
- `content_type: voice`
- 发送时可带 `duration_ms`

---

## 4. 引用回复

### 4.1 数据结构

消息 payload 复用：

```json
{
  "content_type": "text",
  "text": "reply body",
  "reply_to": "msg_target_id",
  "reply_preview": {
    "id": "msg_target_id",
    "fromId": "user_xxx",
    "fromName": "杨宁",
    "text": "原消息摘要",
    "contentType": "text"
  }
}
```

支持内容类型：
- 文本
- 图片
- 视频
- 语音

---

### 4.2 交互流程

1. 长按某条消息
2. 选择“回复”
3. 输入框上方出现回复预览条
4. 发送消息时带上：
   - `reply_to`
   - `reply_preview`
5. 消息气泡中渲染引用块

---

### 4.3 点击引用块跳转

当前实现：
- 点击引用块后调用 `scrollToReply(replyToId)`
- 若当前列表能找到原消息：
  - 自动滚动到原消息
  - 给原消息加高亮态 `highlightRow`
- 若当前列表找不到：
  - 自动补更老历史后再次尝试定位

---

### 4.4 补历史再定位

#### 群聊
- 复用 `getGroupMessages(token, groupId, before)`
- 以当前最老消息 id 作为 `before`
- 最多补 3 轮

#### 私聊
- 使用 `getDMHistory(token, peerId, before, limit)`
- 同样最多补 3 轮

#### 失败兜底
- 若补历史后仍找不到：
  - 引用块显示“原消息不可用”
  - 不崩溃、不乱跳

---

## 5. 语音消息

### 5.1 前端
- `expo-av` 负责录音和播放
- 长按录音，松开发送
- 展示录音中时长
- Web 端暂不支持录音，仅支持播放，并提示用户使用移动端录制

### 5.2 数据字段
- `audioUrl`
- `durationMs`
- `contentType = 'voice'`

---

## 6. 已读 / 状态 / 重发

消息状态：
- `sent`
- `delivered`
- `read`
- `failed`

当前 UI：
- `✓`
- `✓✓`
- `✓✓ 已读`
- 失败时可点击重发

---

## 7. 搜索与跳转

消息搜索页：`MessageSearchScreen.tsx`

支持：
- 搜索 DM + 群聊消息
- 关键词高亮
- 结果点击跳转到聊天

当前“搜索结果跳到聊天”与“聊天内引用跳回原消息”是两层能力：
- 搜索：定位到对话
- 引用块：定位到对话中的具体原消息

---

## 8. 当前已知限制

1. Web 端暂不支持录音
2. `ChatScreen.tsx` 目前承担职责较多，后续适合拆分：
   - `MessageBubble`
   - `ReplyPreviewBlock`
   - `Composer`
   - `VoiceBubble`
   - `useChatMessages` / `useReplyNavigation`
3. DM 初始历史仍以本地缓存 + 补历史为主，后续可再做首屏服务端历史统一拉取
4. 回复定位目前按最多 3 轮分页拉取，后续可再细化为直到命中 / 到底为止

---

## 9. 建议的后续重构方向

### 前端结构
- 抽离消息列表 hooks
- 抽离发送逻辑 hooks
- 拆组件，降低 `ChatScreen.tsx` 复杂度

### 数据层
- 统一 DM / 群聊消息映射函数
- 把 reply preview 的摘要生成逻辑集中管理

### 交互层
- PC Web 会话列表打磨
- 键盘快捷键
- 历史消息懒加载
- 更明确的 loading older 提示

