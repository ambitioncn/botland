import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import WebSocket from 'ws';

import { runDaemon, type DaemonOptions } from './daemon.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type BridgeOptions = {
  webhook?: string;
  stdio: boolean;
  exec?: string;
  cmd?: string;
  shell: boolean;
  passEnv: boolean;
  maxConcurrency?: number;
  timeoutMs?: number;
  json: boolean;
  jsonl: boolean;
  daemon: DaemonOptions;
};

type RawWsMessage = {
  type: string;
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  payload?: unknown;
};

type BridgeEvent = {
  type: 'botland.message' | 'botland.group_message' | 'botland.friend_request' | 'botland.presence' | 'botland.event';
  event_id: string;
  chat: { type: 'direct' | 'group' | 'system'; id: string };
  message?: { id: string; from: { id: string }; text?: string; content_type: string; payload: unknown; timestamp: string };
  raw: RawWsMessage;
};

type BridgeOutbound = {
  type?: string;
  reply?: { text?: string };
  send?: { to?: string; text?: string; chat_type?: 'direct' | 'group' };
  presence?: { state?: string; text?: string };
  text?: string;
};

export async function runBridge(options: BridgeOptions): Promise<void> {
  if (options.webhook) {
    await runDaemon({ ...options.daemon, mode: 'start', adapter: 'webhook', url: options.webhook, json: options.json, jsonl: options.jsonl || options.json });
    return;
  }
  if (!options.stdio && !options.exec) {
    throw new CliError('bridge requires --webhook <url>, --stdio --cmd <command>, or --exec <command>', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }
  if (options.stdio && !options.cmd) {
    throw new CliError('bridge --stdio requires --cmd <command>', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }
  if (options.stdio && options.exec) {
    throw new CliError('bridge --stdio and --exec are mutually exclusive', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }
  if ((options.maxConcurrency ?? 1) !== 1) {
    throw new CliError('bridge currently supports --max-concurrency 1 only', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }

  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const child = options.stdio && options.cmd ? startStdioChild(options) : undefined;
  let chain = Promise.resolve();

  try {
    await runBridgeWs({
      wsUrl: runtime.wsUrl,
      token,
      timeoutMs: options.timeoutMs,
      onEvent: async (ws, event) => {
        if (options.json || options.jsonl) process.stdout.write(`${JSON.stringify(event)}\n`);
        chain = chain.then(async () => {
          if (child) await sendEventToStdioChild(child, event, ws);
          else if (options.exec) await runExecForEvent(options, event, ws);
        });
        await chain;
      },
    });
  } finally {
    child?.kill('SIGTERM');
  }
}

async function runBridgeWs(args: { wsUrl: string; token: string; timeoutMs?: number; onEvent: (ws: WebSocket, event: BridgeEvent) => Promise<void> }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const ws = new WebSocket(withToken(args.wsUrl, args.token), { headers: { Authorization: `Bearer ${args.token}` } });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(1000, 'botland-bridge-complete'); } catch {}
      if (error) reject(error);
      else resolve();
    };
    if (args.timeoutMs !== undefined) timer = setTimeout(() => finish(), args.timeoutMs);
    ws.on('ping', (data) => ws.pong(data));
    ws.on('message', (raw) => {
      void (async () => {
        const msg = parseWsMessage(raw);
        if (!msg || typeof msg.type !== 'string' || msg.type === 'connected') return;
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        const event = toBridgeEvent(msg as RawWsMessage);
        if (!event) return;
        await args.onEvent(ws, event);
      })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
    ws.on('error', (error) => finish(new CliError(`BotLand WebSocket error: ${error.message}`, { code: 'WS_ERROR' })));
    ws.on('close', (code, reason) => {
      if (settled) return;
      finish(new CliError(`BotLand WebSocket closed (code=${code} reason=${reason.toString() || '<empty>'})`, { code: 'WS_CLOSED' }));
    });
  });
}

function startStdioChild(options: BridgeOptions): ChildProcessWithoutNullStreams {
  const { command, args } = parseCommand(options.cmd || '', options.shell);
  const child = spawn(command, args, { shell: options.shell, env: buildChildEnv(options), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => process.stderr.write(`[botland bridge child] ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') process.stderr.write(`[botland bridge child] exited code=${code} signal=${signal || ''}\n`);
  });
  return child;
}

async function sendEventToStdioChild(child: ChildProcessWithoutNullStreams, event: BridgeEvent, ws: WebSocket): Promise<void> {
  child.stdin.write(`${JSON.stringify(event)}\n`);
  const rl = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    const onLine = (line: string): void => {
      void handleChildLine(line, event, ws).then(() => {
        cleanup();
        resolve();
      }, reject);
    };
    const cleanup = (): void => {
      rl.off('line', onLine);
      rl.close();
    };
    rl.once('line', onLine);
    child.once('error', reject);
  });
}

async function runExecForEvent(options: BridgeOptions, event: BridgeEvent, ws: WebSocket): Promise<void> {
  const { command, args } = parseCommand(options.exec || '', options.shell);
  await new Promise<void>((resolve, reject) => {
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30000;
    const child = spawn(command, args, { shell: options.shell, env: { ...buildChildEnv(options), BOTLAND_EVENT: JSON.stringify(event) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CliError(`bridge exec timed out after ${timeoutMs}ms`, { code: 'EXEC_TIMEOUT' }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new CliError(`bridge exec exited with ${code}: ${stderr.trim()}`, { code: 'EXEC_FAILED' }));
        return;
      }
      void handleExecOutput(stdout, event, ws).then(resolve, reject);
    });
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

async function handleExecOutput(stdout: string, event: BridgeEvent, ws: WebSocket): Promise<void> {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return;
  for (const line of lines) await handleChildLine(line, event, ws);
}

async function handleChildLine(line: string, event: BridgeEvent, ws: WebSocket): Promise<void> {
  let out: BridgeOutbound;
  try {
    out = JSON.parse(line) as BridgeOutbound;
  } catch {
    out = { type: 'botland.reply', text: line };
  }
  await applyOutbound(out, event, ws);
}

async function applyOutbound(out: BridgeOutbound, event: BridgeEvent, ws: WebSocket): Promise<void> {
  const kind = out.type || (out.reply ? 'botland.reply' : out.send ? 'botland.send' : out.presence ? 'botland.presence' : out.text ? 'botland.reply' : '');
  if (kind === 'botland.reply') {
    const text = out.reply?.text || out.text;
    if (!text || !event.message) return;
    ws.send(JSON.stringify({
      type: event.chat.type === 'group' ? 'group.message.send' : 'message.send',
      id: `bridge_${Date.now()}`,
      to: event.chat.id,
      payload: { content_type: 'text', text },
    }));
    return;
  }
  if (kind === 'botland.send') {
    const text = out.send?.text;
    const to = out.send?.to;
    if (!text || !to) return;
    ws.send(JSON.stringify({
      type: out.send?.chat_type === 'group' || to.startsWith('group_') ? 'group.message.send' : 'message.send',
      id: `bridge_${Date.now()}`,
      to: to.replace(/^group:/, ''),
      payload: { content_type: 'text', text },
    }));
    return;
  }
  if (kind === 'botland.presence' && out.presence?.state) {
    ws.send(JSON.stringify({ type: 'presence.update', payload: { state: out.presence.state, ...(out.presence.text ? { text: out.presence.text } : {}) } }));
  }
}

function toBridgeEvent(raw: RawWsMessage): BridgeEvent | null {
  if (!isBridgeEventType(raw.type)) return null;
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const groupId = typeof payload.group_id === 'string' ? payload.group_id : undefined;
  const isGroup = raw.type.startsWith('group.') || Boolean(groupId);
  const chat = { type: (isGroup ? 'group' : raw.from ? 'direct' : 'system') as 'direct' | 'group' | 'system', id: groupId || (isGroup ? raw.to : raw.from) || raw.to || 'system' };
  const eventType = raw.type === 'message.received' ? 'botland.message'
    : raw.type === 'group.message.received' ? 'botland.group_message'
      : raw.type === 'friend.request' ? 'botland.friend_request'
        : raw.type === 'presence.changed' ? 'botland.presence'
          : 'botland.event';
  const event: BridgeEvent = { type: eventType, event_id: raw.id || `${raw.type}_${Date.now()}`, chat, raw };
  if (raw.type.includes('message')) {
    event.message = {
      id: raw.id || event.event_id,
      from: { id: raw.from || (typeof payload.sender_id === 'string' ? payload.sender_id : 'unknown') },
      ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
      content_type: typeof payload.content_type === 'string' ? payload.content_type : raw.type,
      payload: raw.payload,
      timestamp: raw.timestamp || new Date().toISOString(),
    };
  }
  return event;
}

function parseCommand(commandLine: string, shell: boolean): { command: string; args: string[] } {
  const trimmed = commandLine.trim();
  if (!trimmed) throw new CliError('bridge command cannot be empty', { code: 'VALIDATION_ERROR', exitCode: 2 });
  if (shell) return { command: trimmed, args: [] };
  const parts = splitCommandLine(trimmed);
  return { command: parts[0], args: parts.slice(1) };
}

function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && !quote) { quote = ch; continue; }
    if (ch === quote) { quote = null; continue; }
    if (/\s/.test(ch) && !quote) {
      if (current) { out.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (quote) throw new CliError('unterminated quote in bridge command', { code: 'VALIDATION_ERROR', exitCode: 2 });
  if (current) out.push(current);
  if (out.length === 0) throw new CliError('bridge command cannot be empty', { code: 'VALIDATION_ERROR', exitCode: 2 });
  return out;
}

function buildChildEnv(options: BridgeOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = options.passEnv ? { ...process.env } : { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG };
  if (!options.passEnv) {
    delete env.BOTLAND_TOKEN;
    delete env.BOTLAND_CONFIG;
    delete env.BOTLAND_BASE_URL;
    delete env.BOTLAND_WS_URL;
  }
  return env;
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

function isBridgeEventType(type: string): boolean {
  return type === 'message.received' || type === 'group.message.received' || type === 'message.reaction' || type === 'typing.indicator' || type === 'presence.changed' || type === 'system.notification' || type === 'friend.request';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
