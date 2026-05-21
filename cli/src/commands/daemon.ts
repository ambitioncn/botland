import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import WebSocket from 'ws';

import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type DaemonOptions = {
  mode?: string;
  adapter?: string;
  url?: string;
  secret?: string;
  statePath?: string;
  deadLetterPath?: string;
  timeoutMs?: number;
  retryMs?: number;
  retries?: number;
  reconnectMaxMs?: number;
  presence?: string;
  json: boolean;
  jsonl: boolean;
  healthPort?: number; // HTTP port for /health endpoint
};

type NormalizedEvent = {
  event_id: string;
  event_type: string;
  chat: { type: 'direct' | 'group' | 'system'; id: string; name?: string };
  message?: {
    id: string;
    from: { id: string; handle?: string; display_name?: string };
    text?: string;
    content_type: string;
    payload: unknown;
    timestamp: string;
  };
  raw: WatchMessage;
};

type WatchMessage = {
  type: string;
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  payload?: unknown;
};

type StateRecord =
  | { type: 'seen'; event_id: string; event_type?: string; ts: string }
  | { type: 'dead_letter'; event_id?: string; reason: string; ts: string; event?: unknown }
  | { type: 'outbound'; dedupe_key: string; message_id?: string; ts: string };

type DaemonState = { seen: Set<string>; outbound: Set<string> };

type HealthState = {
  connected: boolean;
  lastHeartbeat: string;
  eventsReceived: number;
  webhooksDelivered: number;
};

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const mode = options.mode ?? 'start';
  if (mode !== 'start') {
    throw new CliError(`Unsupported daemon subcommand: ${mode}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
  }
  if (options.adapter && options.adapter !== 'webhook') {
    throw new CliError('--adapter currently supports only webhook', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }
  if (options.adapter === 'webhook' && !options.url) {
    throw new CliError('daemon --adapter webhook requires --url <http-url>', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }

  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const statePath = options.statePath || defaultDaemonPath('state.jsonl');
  const deadLetterPath = options.deadLetterPath || defaultDaemonPath('dead-letter.jsonl');
  const state = await loadState(statePath);
  const startedAt = Date.now();
  let attempt = 0;

  // Start health endpoint if requested
  const healthState = { connected: false, lastHeartbeat: '', eventsReceived: 0, webhooksDelivered: 0 };
  if (options.healthPort) {
    startHealthEndpoint(options.healthPort, startedAt, healthState);
  }

  while (true) {
    if (timedOut(startedAt, options.timeoutMs)) return;
    const remaining = remainingMs(startedAt, options.timeoutMs);
    try {
      await runDaemonConnection({
        wsUrl: runtime.wsUrl,
        token,
        state,
        statePath,
        deadLetterPath,
        options,
        remainingMs: remaining,
        healthState: options.healthPort ? healthState : undefined,
      });
      return;
    } catch {
      if (timedOut(startedAt, options.timeoutMs)) return;
      attempt += 1;
      const delay = Math.min(options.reconnectMaxMs ?? 5000, 250 * 2 ** Math.min(attempt - 1, 5));
      await sleep(Math.min(delay, remainingMs(startedAt, options.timeoutMs) ?? delay));
    }
  }
}

function startHealthEndpoint(port: number, startedAt: number, state: HealthState): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      const uptime = Math.floor((Date.now() - startedAt) / 1000);
      const health = {
        status: state.connected ? 'healthy' : 'disconnected',
        uptime_seconds: uptime,
        websocket_connected: state.connected,
        last_heartbeat: state.lastHeartbeat || 'never',
        events_received: state.eventsReceived,
        webhooks_delivered: state.webhooksDelivered,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });
  server.listen(port, () => {
    if (process.env.DEBUG) console.error(`Health endpoint listening on http://localhost:${port}/health`);
  });
}

async function runDaemonConnection(args: {
  wsUrl: string;
  token: string;
  state: DaemonState;
  statePath: string;
  deadLetterPath: string;
  options: DaemonOptions;
  remainingMs?: number;
  healthState?: HealthState;
}): Promise<void> {
  const url = withToken(args.wsUrl, args.token);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${args.token}` } });

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(1000, 'botland-daemon-complete'); } catch {}
      if (error) reject(error);
      else resolve();
    };

    if (args.remainingMs !== undefined) timer = setTimeout(() => finish(), args.remainingMs);

    ws.on('open', () => {
      if (args.healthState) {
        args.healthState.connected = true;
        args.healthState.lastHeartbeat = new Date().toISOString();
      }
      const presence = normalizePresence(args.options.presence);
      if (presence) ws.send(JSON.stringify({ type: 'presence.update', payload: presence }));
    });

    ws.on('ping', (data) => ws.pong(data));

    ws.on('message', (raw) => {
      void (async () => {
        const msg = parseWsMessage(raw);
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'connected') return;
        if (msg.type === 'ping') {
          if (args.healthState) args.healthState.lastHeartbeat = new Date().toISOString();
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (msg.type === 'error') {
          const payload = isRecord(msg.payload) ? msg.payload : {};
          await writeDeadLetter(args.deadLetterPath, { reason: String(payload.message || 'BotLand WebSocket error'), event: msg });
          return;
        }
        if (!isDaemonEventType(msg.type)) return;
        const event = normalizeEvent(msg as WatchMessage);
        if (args.state.seen.has(event.event_id)) return;
        args.state.seen.add(event.event_id);
        if (args.healthState) args.healthState.eventsReceived += 1;
        await appendState(args.statePath, { type: 'seen', event_id: event.event_id, event_type: event.event_type, ts: new Date().toISOString() });
        if (args.options.json || args.options.jsonl || !args.options.adapter) process.stdout.write(`${JSON.stringify(event)}\n`);
        if (args.options.adapter === 'webhook' && args.options.url) {
          const response = await deliverWebhook({
            url: args.options.url,
            secret: args.options.secret,
            event,
            retries: args.options.retries ?? 2,
            retryMs: args.options.retryMs ?? 250,
            deadLetterPath: args.deadLetterPath,
          });
          if (args.healthState && response !== undefined) args.healthState.webhooksDelivered += 1;
          const replyText = extractReplyText(response);
          if (replyText && event.message) {
            const dedupeKey = `reply:${event.event_id}`;
            if (!args.state.outbound.has(dedupeKey)) {
              args.state.outbound.add(dedupeKey);
              const messageId = `daemon_${Date.now()}_${randomUUID().slice(0, 8)}`;
              ws.send(JSON.stringify({
                type: event.chat.type === 'group' ? 'group.message.send' : 'message.send',
                id: messageId,
                to: event.chat.id,
                payload: { content_type: 'text', text: replyText },
              }));
              await appendState(args.statePath, { type: 'outbound', dedupe_key: dedupeKey, message_id: messageId, ts: new Date().toISOString() });
            }
          }
        }
      })().catch((error) => {
        void writeDeadLetter(args.deadLetterPath, { reason: error instanceof Error ? error.message : String(error) });
      });
    });

    ws.on('error', (error) => {
      if (args.healthState) args.healthState.connected = false;
      finish(new CliError(`BotLand WebSocket error: ${error.message}`, { code: 'WS_ERROR' }));
    });
    ws.on('close', (code, reason) => {
      if (args.healthState) args.healthState.connected = false;
      if (settled) return;
      if (code === 1000 && reason.toString() === 'botland-daemon-complete') finish();
      else finish(new CliError(`BotLand WebSocket closed (code=${code} reason=${reason.toString() || '<empty>'})`, { code: 'WS_CLOSED' }));
    });
  });
}

function normalizeEvent(raw: WatchMessage): NormalizedEvent {
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const groupId = typeof payload.group_id === 'string' ? payload.group_id : undefined;
  const isGroup = raw.type.startsWith('group.') || Boolean(groupId);
  const chatId = groupId || (isGroup ? raw.to : raw.from) || raw.to || 'system';
  const text = typeof payload.text === 'string' ? payload.text : undefined;
  const contentType = typeof payload.content_type === 'string' ? payload.content_type : raw.type;
  const timestamp = raw.timestamp || new Date().toISOString();
  const messageId = raw.id || `${raw.type}_${timestamp}`;
  const event: NormalizedEvent = {
    event_id: messageId,
    event_type: raw.type,
    chat: { type: isGroup ? 'group' : raw.from ? 'direct' : 'system', id: chatId },
    raw,
  };
  if (raw.type.includes('message')) {
    event.message = {
      id: messageId,
      from: { id: raw.from || (typeof payload.sender_id === 'string' ? payload.sender_id : 'unknown') },
      ...(text ? { text } : {}),
      content_type: contentType,
      payload: raw.payload,
      timestamp,
    };
  }
  return event;
}

async function deliverWebhook(args: { url: string; secret?: string; event: NormalizedEvent; retries: number; retryMs: number; deadLetterPath: string }): Promise<unknown> {
  const body = JSON.stringify(args.event);
  let lastError = '';
  for (let attempt = 0; attempt <= args.retries; attempt += 1) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (args.secret) headers['X-Botland-Signature'] = `sha256=${createHmac('sha256', args.secret).update(body).digest('hex')}`;
      const res = await fetch(args.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}: ${text}`);
      return text.trim() ? JSON.parse(text) as unknown : undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < args.retries) await sleep(args.retryMs * (attempt + 1));
    }
  }
  await writeDeadLetter(args.deadLetterPath, { event_id: args.event.event_id, reason: lastError || 'webhook delivery failed', event: args.event });
  return undefined;
}

async function loadState(path: string): Promise<DaemonState> {
  const state: DaemonState = { seen: new Set(), outbound: new Set() };
  try {
    const raw = await readFile(path, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as StateRecord;
      if (record.type === 'seen') state.seen.add(record.event_id);
      if (record.type === 'outbound') state.outbound.add(record.dedupe_key);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return state;
}

async function appendState(path: string, record: StateRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function writeDeadLetter(path: string, record: { event_id?: string; reason: string; event?: unknown }): Promise<void> {
  await appendState(path, { type: 'dead_letter', ...record, ts: new Date().toISOString() });
}

function extractReplyText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const reply = value.reply;
  if (!isRecord(reply)) return undefined;
  return typeof reply.text === 'string' && reply.text.trim() ? reply.text.trim() : undefined;
}

function normalizePresence(raw: string | undefined): { state: string; text?: string } | undefined {
  if (!raw) return undefined;
  const [state, ...rest] = raw.split(':');
  if (!['online', 'idle', 'dnd'].includes(state)) throw new CliError('--presence must start with online, idle, or dnd', { code: 'VALIDATION_ERROR', exitCode: 2 });
  const text = rest.join(':').trim();
  return { state, ...(text ? { text } : {}) };
}

function defaultDaemonPath(file: string): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'botland', file);
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
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isDaemonEventType(type: string): boolean {
  return type === 'message.received' || type === 'group.message.received' || type === 'message.reaction' || type === 'typing.indicator' || type === 'presence.changed' || type === 'system.notification' || type === 'friend.request';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timedOut(startedAt: number, timeoutMs: number | undefined): boolean {
  return timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs;
}

function remainingMs(startedAt: number, timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}
