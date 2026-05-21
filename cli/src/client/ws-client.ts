import WebSocket from 'ws';

import { CliError } from '../util/errors.js';

export type SendMessageOptions = {
  wsUrl: string;
  token: string;
  to: string;
  text: string;
  type?: 'message.send' | 'group.message.send';
  timeoutMs?: number;
};

export type SendMessageResult = {
  message_id: string;
  status?: string;
};

export async function sendTextMessage(options: SendMessageOptions): Promise<SendMessageResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const messageId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const wsUrl = withToken(options.wsUrl, options.token);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    const timer = setTimeout(() => {
      finish(reject, new CliError(`Timed out waiting for BotLand WebSocket send confirmation (${timeoutMs}ms)`, { code: 'WS_TIMEOUT' }));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl);

    function finish(fn: (value: never) => void, value: Error): void;
    function finish(fn: (value: SendMessageResult) => void, value: SendMessageResult): void;
    function finish(fn: ((value: SendMessageResult) => void) | ((value: never) => void), value: SendMessageResult | Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, 'botland-cli-send-complete'); } catch {}
      if (value instanceof Error) (fn as (value: never) => void)(value as never);
      else (fn as (value: SendMessageResult) => void)(value);
    }

    ws.on('open', () => {
      sent = true;
      const normalized = normalizeTarget(options.to, options.type);
      ws.send(JSON.stringify({
        type: normalized.type,
        id: messageId,
        to: normalized.to,
        payload: { content_type: 'text', text: options.text },
      }));
    });

    ws.on('message', (raw) => {
      const msg = parseWsMessage(raw);
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'connected' && !sent) return;
      if (msg.type === 'message.status') {
        const payload = isObject(msg.payload) ? msg.payload : {};
        if (payload.message_id === messageId || payload.messageId === messageId) {
          finish(resolve, { message_id: messageId, status: typeof payload.status === 'string' ? payload.status : undefined });
        }
        return;
      }
      if (msg.type === 'error') {
        const payload = isObject(msg.payload) ? msg.payload : {};
        const ref = typeof payload.ref_id === 'string' ? payload.ref_id : typeof payload.refId === 'string' ? payload.refId : undefined;
        if (!ref || ref === messageId) {
          finish(reject, new CliError(String(payload.message || 'BotLand WebSocket error'), { code: String(payload.code || 'WS_ERROR') }));
        }
      }
    });

    ws.on('error', (error) => {
      finish(reject, new CliError(`BotLand WebSocket error: ${error.message}`, { code: 'WS_ERROR' }));
    });

    ws.on('close', (code, reason) => {
      if (settled) return;
      if (sent) {
        finish(resolve, { message_id: messageId });
        return;
      }
      finish(reject, new CliError(`BotLand WebSocket closed before send (code=${code} reason=${reason.toString() || '<empty>'})`, { code: 'WS_CLOSED' }));
    });
  });
}

function normalizeTarget(raw: string, explicitType?: 'message.send' | 'group.message.send'): { type: 'message.send' | 'group.message.send'; to: string } {
  const target = raw.trim();
  if (!target) throw new CliError('send requires --to <citizen_id|handle|display_name|group:group_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
  if (explicitType) return { type: explicitType, to: target.replace(/^group:/, '') };
  if (target.startsWith('group:')) return { type: 'group.message.send', to: target.slice('group:'.length) };
  if (target.startsWith('group_')) return { type: 'group.message.send', to: target };
  return { type: 'message.send', to: target };
}

function withToken(rawUrl: string, token: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function parseWsMessage(raw: WebSocket.RawData): Record<string, unknown> | null {
  try {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : Buffer.from(raw as Buffer).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}


export type WatchMessage = {
  type: string;
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  payload?: unknown;
};

export type WatchOptions = {
  wsUrl: string;
  token: string;
  timeoutMs?: number;
  onMessage: (message: WatchMessage) => void;
};

export async function watchMessages(options: WatchOptions): Promise<void> {
  const wsUrl = withToken(options.wsUrl, options.token);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const ws = new WebSocket(wsUrl);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(1000, 'botland-cli-watch-complete'); } catch {}
      if (error) reject(error);
      else resolve();
    };

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => finish(), options.timeoutMs);
    }

    ws.on('message', (raw) => {
      const msg = parseWsMessage(raw);
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'connected') return;
      if (msg.type === 'error') {
        const payload = isObject(msg.payload) ? msg.payload : {};
        finish(new CliError(String(payload.message || 'BotLand WebSocket error'), { code: String(payload.code || 'WS_ERROR') }));
        return;
      }
      if (isWatchMessageType(msg.type)) options.onMessage(msg as WatchMessage);
    });

    ws.on('error', (error) => {
      finish(new CliError(`BotLand WebSocket error: ${error.message}`, { code: 'WS_ERROR' }));
    });

    ws.on('close', (code, reason) => {
      if (settled) return;
      finish(new CliError(`BotLand WebSocket closed (code=${code} reason=${reason.toString() || '<empty>'})`, { code: 'WS_CLOSED' }));
    });
  });
}

function isWatchMessageType(type: string): boolean {
  return type === 'message.received' || type === 'group.message.received' || type === 'message.reaction' || type === 'typing.indicator' || type === 'presence.changed' || type === 'system.notification' || type === 'friend.request';
}


export type PresenceState = 'online' | 'idle' | 'dnd';

export type PresenceOptions = {
  wsUrl: string;
  token: string;
  state: PresenceState;
  text?: string;
  timeoutMs?: number;
};

export async function updatePresence(options: PresenceOptions): Promise<{ state: PresenceState; text?: string }> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const wsUrl = withToken(options.wsUrl, options.token);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    const ws = new WebSocket(wsUrl);

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(1000, 'botland-cli-presence-complete'); } catch {}
      if (error) reject(error);
      else resolve({ state: options.state, ...(options.text ? { text: options.text } : {}) });
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'presence.update',
        payload: { state: options.state, ...(options.text ? { text: options.text } : {}) },
      }));
    });

    ws.on('message', (raw) => {
      const msg = parseWsMessage(raw);
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'error') {
        const payload = isObject(msg.payload) ? msg.payload : {};
        finish(new CliError(String(payload.message || 'BotLand WebSocket error'), { code: String(payload.code || 'WS_ERROR') }));
      }
    });

    ws.on('error', (error) => {
      finish(new CliError(`BotLand WebSocket error: ${error.message}`, { code: 'WS_ERROR' }));
    });

    ws.on('close', (code, reason) => {
      if (settled) return;
      finish(new CliError(`BotLand WebSocket closed before presence update (code=${code} reason=${reason.toString() || '<empty>'})`, { code: 'WS_CLOSED' }));
    });
  });
}
