import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type MessagesOptions = {
  subcommand?: string;
  id?: string;
  text?: string;
  query?: string;
  queryParts?: string[];
  limit?: number;
  json: boolean;
};

export async function runMessages(options: MessagesOptions): Promise<void> {
  const sub = options.subcommand || 'search';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });

  if (sub === 'reply') {
    const messageId = options.id?.trim();
    const text = (options.text || options.queryParts?.join(' ') || '').trim();
    if (!messageId) throw new CliError('messages reply requires <message_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    if (!text) throw new CliError('messages reply requires reply text', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const response = await client.replyToMessage({ messageId, text });
    if (options.json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else process.stdout.write(`Replied to ${messageId}; new message ${response.message_id}.\n`);
    return;
  }

  if (sub !== 'search') throw new CliError(`Unknown messages subcommand: ${sub}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
  const query = (options.query || options.queryParts?.join(' ') || '').trim();
  if (query.length < 2) throw new CliError('messages search requires a query of at least 2 characters', { code: 'VALIDATION_ERROR', exitCode: 2 });

  const response = await client.searchMessages({ query, limit: options.limit });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  if (response.results.length === 0) {
    process.stdout.write(`No messages matched "${query}".\n`);
    return;
  }
  for (const item of response.results) {
    process.stdout.write(`[${item.timestamp || ''}] ${item.chat_type}:${item.peer_name || item.chat_id} ${item.from_name || item.from_id}: ${item.text || ''}\n`);
  }
}
