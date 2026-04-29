/**
 * wsManager.ts — Global WebSocket manager for BotLand App
 *
 * Features:
 * - Application-level ping/pong heartbeat (every 25s)
 * - Automatic reconnect with exponential backoff (1s → 2s → 4s → ... → 30s cap)
 * - Send queue: messages queued while disconnected are flushed on reconnect
 * - Connection state observable (for UI binding)
 * - Token refresh on reconnect
 * - Singleton: one WS connection shared across screens
 */

import auth from './auth';

const WS_URL = 'wss://api.botland.im/ws';
const PING_INTERVAL = 15_000;       // 25s — well within server's 90s pongWait
const PONG_TIMEOUT = 6_000;        // expect pong within 10s
const RECONNECT_BASE = 1_000;       // start at 1s
const RECONNECT_MAX = 10_000;       // cap at 30s
const RECONNECT_FACTOR = 2;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type InboundHandler = (data: any) => void;

type StateListener = (state: ConnectionState) => void;
export type TypingSnapshot = { active: boolean; name?: string; from?: string };
type TypingListener = (snapshot: TypingSnapshot) => void;
const EMPTY_TYPING: TypingSnapshot = { active: false, name: '', from: '' };

class WSManager {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private stateListeners = new Set<StateListener>();
  private messageHandlers = new Set<InboundHandler>();
  private typingState = new Map<string, TypingSnapshot>();
  private typingListeners = new Map<string, Set<TypingListener>>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  private sendQueue: string[] = [];
  private intentionalClose = false;
  private citizenId: string = '';

  // --- Public API ---

  /** Connect (or reconnect). Safe to call multiple times. */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;

    const token = await auth.getAccessToken();
    const cid = await auth.getCitizenId();
    if (!token || !cid) {
      this.setState('disconnected');
      return;
    }
    this.citizenId = cid;
    this.intentionalClose = false;
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    this.doConnect(token);
  }

  /** Graceful disconnect. No auto-reconnect. */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.setState('disconnected');
  }

  /** Send a JSON-serializable object. Queues if not connected. */
  send(obj: object): void {
    const data = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.sendQueue.push(data);
    }
  }

  /** Subscribe to inbound messages (parsed JSON). Returns unsubscribe fn. */
  onMessage(handler: InboundHandler): () => void {
    this.messageHandlers.add(handler);
    return () => { this.messageHandlers.delete(handler); };
  }

  /** Subscribe to connection state changes. Returns unsubscribe fn. */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    // Fire immediately with current state
    listener(this.state);
    return () => { this.stateListeners.delete(listener); };
  }

  onTypingChange(chatKey: string, listener: TypingListener): () => void {
    let set = this.typingListeners.get(chatKey);
    if (!set) {
      set = new Set<TypingListener>();
      this.typingListeners.set(chatKey, set);
    }
    set.add(listener);
    listener(this.typingState.get(chatKey) || EMPTY_TYPING);
    return () => {
      const curr = this.typingListeners.get(chatKey);
      if (!curr) return;
      curr.delete(listener);
      if (curr.size === 0) this.typingListeners.delete(chatKey);
    };
  }

  getTyping(chatKey: string): TypingSnapshot {
    return this.typingState.get(chatKey) || EMPTY_TYPING;
  }

  subscribeTyping(chatKey: string, listener: () => void): () => void {
    return this.onTypingChange(chatKey, () => listener());
  }

  getTypingSnapshot(chatKey: string): TypingSnapshot {
    return this.getTyping(chatKey);
  }

  getState(): ConnectionState { return this.state; }
  getCitizenId(): string { return this.citizenId; }

  sendGroupMessage(groupId: string, text: string, mentions?: { citizen_id: string; display_name: string; offset: number }[]): void {
    this.send({
      type: 'group.message.send',
      to: groupId,
      payload: { content_type: 'text', text, ...(mentions && mentions.length ? { mentions } : {}) },
    });
  }

  // --- Internals ---

  private doConnect(token: string): void {
    try {
      this.ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState('connected');
      this.startPing();
      this.flushQueue();
    };

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        // Handle pong (application-level)
        if (data.type === 'pong') {
          this.clearPongTimeout();
          return;
        }

        this.handleTypingEvent(data);

        // Dispatch to all handlers
        this.messageHandlers.forEach(h => {
          try { h(data); } catch {}
        });
      } catch {}
    };

    this.ws.onerror = () => {
      // onclose will also fire, handle reconnect there
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws = null;
      }
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
    };
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));

        // Start pong timeout
        this.pongTimer = setTimeout(() => {
          // No pong received — connection is dead, force reconnect
          console.warn('[wsManager] pong timeout, forcing reconnect');
          this.ws?.close();
        }, PONG_TIMEOUT);
      }
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.clearPongTimeout();
  }

  private clearPongTimeout(): void {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.cleanup(false); // clean ws/timers but don't reset state to disconnected
    const delay = Math.min(RECONNECT_BASE * Math.pow(RECONNECT_FACTOR, this.reconnectAttempt), RECONNECT_MAX);
    this.reconnectAttempt++;
    this.setState('reconnecting');
    console.log(`[wsManager] reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => { this.connect(); }, delay);
  }

  private flushQueue(): void {
    while (this.sendQueue.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(this.sendQueue.shift()!);
    }
  }

  private cleanup(resetWs = true): void {
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (resetWs && this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  private emitTyping(chatKey: string): void {
    const snap = this.typingState.get(chatKey) || EMPTY_TYPING;
    const listeners = this.typingListeners.get(chatKey);
    if (!listeners) return;
    listeners.forEach((l) => {
      try { l(snap); } catch {}
    });
  }

  private setTyping(chatKey: string, snapshot: TypingSnapshot): void {
    this.typingState.set(chatKey, snapshot);
    this.emitTyping(chatKey);
  }

  private clearTyping(chatKey: string): void {
    this.typingState.set(chatKey, EMPTY_TYPING);
    const timer = this.typingTimers.get(chatKey);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(chatKey);
    }
    this.emitTyping(chatKey);
  }

  private handleTypingEvent(data: any): void {
    if (!data || data.from === this.citizenId) return;
    const t = data.type;
    if (t !== 'typing.start' && t !== 'typing.stop' && t !== 'group.typing.start' && t !== 'group.typing.stop') return;

    const chatKey = t.startsWith('group.') ? String(data.to || '') : String(data.from || '');
    if (!chatKey) return;

    if (t.endsWith('.start') || t === 'typing.start') {
      this.setTyping(chatKey, { active: true, name: data.fromName || data.from?.slice(-6) || '', from: data.from });
      const existing = this.typingTimers.get(chatKey);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => this.clearTyping(chatKey), 4000);
      this.typingTimers.set(chatKey, timer);
      return;
    }

    this.clearTyping(chatKey);
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateListeners.forEach(l => {
      try { l(s); } catch {}
    });
  }
}

// Singleton
const wsManager = new WSManager();
export default wsManager;
