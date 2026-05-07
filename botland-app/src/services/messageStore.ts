import { Platform } from 'react-native';

// Message type used throughout the app
export type MessageSegment = { type: 'text'; text: string } | { type: 'mention'; citizen_id: string; display_name: string };

export type MessageReplyPreview = {
  id: string;
  fromId?: string;
  fromName?: string;
  text?: string;
  contentType?: string;
};

export type MessageReaction = {
  emoji: string;
  count: number;
  myReaction: boolean;
};

export type StoredMessage = {
  id: string;
  chatId: string;       // the other party's citizen_id
  fromId: string;
  fromName?: string;    // sender display name (group chat)
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  durationMs?: number;
  segments?: MessageSegment[];
  replyTo?: string;
  replyPreview?: MessageReplyPreview;
  contentType: string;   // 'text' | 'image' | 'video' | 'voice'
  mine: boolean;
  timestamp: number;     // unix ms
  status: 'sent' | 'delivered' | 'read' | 'failed';
  reactions?: MessageReaction[];
};

// Chat summary for conversation list
export type ChatSummary = {
  chatId: string;
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
};

// --- Web fallback using localStorage ---
const WEB_KEY = 'botland_messages';

function webGetAll(): Record<string, StoredMessage[]> {
  try {
    const raw = localStorage.getItem(WEB_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function webSaveAll(data: Record<string, StoredMessage[]>) {
  localStorage.setItem(WEB_KEY, JSON.stringify(data));
}

// --- SQLite for native ---
let db: any = null;

async function getDb() {
  if (db) return db;
  if (Platform.OS === 'web') return null;
  try {
    const SQLite = await import('expo-sqlite');
    db = await SQLite.openDatabaseAsync('botland_messages');
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        text TEXT,
        image_url TEXT,
        video_url TEXT,
        audio_url TEXT,
        duration_ms INTEGER,
        content_type TEXT DEFAULT 'text',
        segments TEXT,
        reply_to TEXT,
        reply_preview TEXT,
        mine INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        status TEXT DEFAULT 'sent'
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
      ALTER TABLE messages ADD COLUMN reply_to TEXT;
      ALTER TABLE messages ADD COLUMN reply_preview TEXT;
    `);
    return db;
  } catch (e) {
    console.error('SQLite init error:', e);
    return null;
  }
}

// --- Public API ---

export const messageStore = {
  /** Save a message */
  async save(msg: StoredMessage): Promise<void> {
    if (Platform.OS === 'web') {
      const all = webGetAll();
      if (!all[msg.chatId]) all[msg.chatId] = [];
      // Avoid duplicates
      const existing = all[msg.chatId].findIndex(m => m.id === msg.id);
      if (existing >= 0) {
        all[msg.chatId][existing] = msg;
      } else {
        all[msg.chatId].push(msg);
        // Keep last 500 per chat
        if (all[msg.chatId].length > 500) {
          all[msg.chatId] = all[msg.chatId].slice(-500);
        }
      }
      webSaveAll(all);
      return;
    }

    const database = await getDb();
    if (!database) return;
    await database.runAsync(
      `INSERT OR REPLACE INTO messages (id, chat_id, from_id, text, image_url, video_url, audio_url, duration_ms, content_type, segments, reply_to, reply_preview, mine, timestamp, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.id, msg.chatId, msg.fromId, msg.text || null, msg.imageUrl || null, msg.videoUrl || null, msg.audioUrl || null, msg.durationMs || null,
      msg.contentType, msg.segments ? JSON.stringify(msg.segments) : null, msg.replyTo || null, msg.replyPreview ? JSON.stringify(msg.replyPreview) : null, msg.mine ? 1 : 0, msg.timestamp, msg.status
    );
  },

  /** Get messages for a chat, ordered by time */
  async getMessages(chatId: string, limit: number = 100): Promise<StoredMessage[]> {
    if (Platform.OS === 'web') {
      const all = webGetAll();
      const msgs = all[chatId] || [];
      return msgs.slice(-limit).sort((a, b) => a.timestamp - b.timestamp);
    }

    const database = await getDb();
    if (!database) return [];
    const rows = await database.getAllAsync(
      `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`,
      chatId, limit
    );
    return (rows as any[]).reverse().map(r => ({
      id: r.id,
      chatId: r.chat_id,
      fromId: r.from_id,
      text: r.text,
      imageUrl: r.image_url,
      videoUrl: r.video_url,
      audioUrl: r.audio_url,
      durationMs: r.duration_ms || undefined,
      contentType: r.content_type,
      segments: r.segments ? JSON.parse(r.segments) : undefined,
      replyTo: r.reply_to || undefined,
      replyPreview: r.reply_preview ? JSON.parse(r.reply_preview) : undefined,
      mine: !!r.mine,
      timestamp: r.timestamp,
      status: r.status,
    }));
  },

  /** Update message status */
  async updateStatus(messageId: string, status: 'delivered' | 'read' | 'failed'): Promise<void> {
    if (Platform.OS === 'web') {
      const all = webGetAll();
      for (const chatId of Object.keys(all)) {
        const msg = all[chatId].find(m => m.id === messageId);
        if (msg) {
          msg.status = status;
          webSaveAll(all);
          return;
        }
      }
      return;
    }

    const database = await getDb();
    if (!database) return;
    await database.runAsync(
      `UPDATE messages SET status = ? WHERE id = ?`,
      status, messageId
    );
  },

  /** Get chat summaries (last message per chat) */
  async getChatSummaries(): Promise<ChatSummary[]> {
    if (Platform.OS === 'web') {
      const all = webGetAll();
      return Object.entries(all).map(([chatId, msgs]) => {
        const last = msgs[msgs.length - 1];
        return {
          chatId,
          lastMessage: last?.text || (last?.imageUrl ? '[图片]' : last?.audioUrl ? '[语音]' : ''),
          lastTimestamp: last?.timestamp || 0,
          unreadCount: 0,
        };
      }).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    }

    const database = await getDb();
    if (!database) return [];
    const rows = await database.getAllAsync(`
      SELECT chat_id, text, image_url, audio_url, content_type, timestamp
      FROM messages
      WHERE id IN (SELECT id FROM messages GROUP BY chat_id HAVING timestamp = MAX(timestamp))
      ORDER BY timestamp DESC
    `);
    return (rows as any[]).map(r => ({
      chatId: r.chat_id,
      lastMessage: r.text || (r.image_url ? '[图片]' : r.audio_url ? '[语音]' : ''),
      lastTimestamp: r.timestamp,
      unreadCount: 0,
    }));
  },

  /** Delete all messages for a chat */
  async deleteChat(chatId: string): Promise<void> {
    if (Platform.OS === 'web') {
      const all = webGetAll();
      delete all[chatId];
      webSaveAll(all);
      return;
    }

    const database = await getDb();
    if (!database) return;
    await database.runAsync(`DELETE FROM messages WHERE chat_id = ?`, chatId);
  },

  /** Clear all local messages */
  async clearAll(): Promise<void> {
    if (Platform.OS === 'web') {
      localStorage.removeItem(WEB_KEY);
      return;
    }

    const database = await getDb();
    if (!database) return;
    await database.execAsync(`DELETE FROM messages`);
  },
};

export default messageStore;
