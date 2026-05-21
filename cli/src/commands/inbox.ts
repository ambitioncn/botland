import { BotLandClient } from '../client/botland-client.js';
import { resolveMessageTarget } from '../client/target-resolver.js';
import type { DMMessage } from '../client/types.js';
import { watchMessages, type WatchMessage } from '../client/ws-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type InboxOptions = {
  mode?: string;
  peer?: string;
  limit?: number;
  before?: string;
  timeoutMs?: number;
  json: boolean;
  jsonl?: boolean;
};

export async function runInbox(options: InboxOptions): Promise<void> {
  if (options.mode === 'watch') {
    await runInboxWatch(options);
    return;
  }
  await runInboxHistory(options);
}

async function runInboxHistory(options: InboxOptions): Promise<void> {
  const peer = options.peer?.trim();
  if (!peer) throw new CliError('inbox requires --peer <citizen_id|handle|display_name> or use inbox watch', { code: 'VALIDATION_ERROR', exitCode: 2 });
  const limit = normalizeLimit(options.limit);

  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });
  const resolved = await resolveMessageTarget(client, peer);
  if (resolved.isGroup) {
    throw new CliError('inbox currently supports direct messages only; group history will be added separately', { code: 'UNSUPPORTED_TARGET', exitCode: 2 });
  }

  const messages = await client.getDMHistory({ peer: resolved.to, limit, before: options.before });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ peer: resolved, messages }, null, 2)}\n`);
    return;
  }

  if (messages.length === 0) {
    process.stdout.write(`No messages with ${resolved.to}.\n`);
    return;
  }
  for (const message of messages.slice().reverse()) {
    process.stdout.write(formatMessage(message));
  }
}

async function runInboxWatch(options: InboxOptions): Promise<void> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    throw new CliError('--timeout-ms must be a non-negative number', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  await watchMessages({
    wsUrl: runtime.wsUrl,
    token,
    timeoutMs: options.timeoutMs,
    onMessage: (message) => {
      if (options.json || options.jsonl) process.stdout.write(`${JSON.stringify(message)}\n`);
      else process.stdout.write(formatWatchMessage(message));
    },
  });
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isFinite(limit) || limit <= 0) throw new CliError('--limit must be a positive number', { code: 'VALIDATION_ERROR', exitCode: 2 });
  return Math.min(200, Math.floor(limit));
}

function formatMessage(message: DMMessage): string {
  const sender = message.sender_name || message.sender_id;
  const text = formatPayload(message.payload);
  return `[${message.created_at}] ${sender}: ${text}\n`;
}

function formatWatchMessage(message: WatchMessage): string {
  const from = message.from || 'unknown';
  const text = formatPayload(isRecord(message.payload) ? message.payload : undefined);
  const prefix = message.timestamp ? `[${message.timestamp}]` : '[live]';
  return `${prefix} ${message.type} from ${from}: ${text}\n`;
}

function formatPayload(payload: DMMessage['payload'] | Record<string, unknown> | undefined): string {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text;
  const contentType = typeof payload.content_type === 'string' ? payload.content_type : 'message';
  const media = typeof payload.media_url === 'string' ? payload.media_url : typeof payload.url === 'string' ? payload.url : '';
  return media ? `[${contentType}] ${media}` : `[${contentType}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
