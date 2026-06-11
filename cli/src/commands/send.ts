import { BotLandClient } from '../client/botland-client.js';
import { messageTypeForResolvedTarget, resolveMessageTarget } from '../client/target-resolver.js';
import { sendTextMessage } from '../client/ws-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type SendOptions = {
  to?: string;
  textParts: string[];
  json: boolean;
};

export async function runSend(options: SendOptions): Promise<void> {
  const to = options.to?.trim();
  if (!to) throw new CliError('send requires --to <citizen_id|handle|display_name|group:group_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
  const text = options.textParts.join(' ').trim();
  if (!text) throw new CliError('send requires message text', { code: 'VALIDATION_ERROR', exitCode: 2 });

  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });
  const resolved = await resolveMessageTarget(client, to);
  let result: { message_id: string; status?: string; to?: string };
  try {
    result = await client.sendMessage({ to: resolved.to, text });
  } catch (error) {
    if (!(error instanceof CliError) || (error.code !== 'HTTP_404' && error.code !== 'NOT_FOUND')) throw error;
    result = await sendTextMessage({ wsUrl: runtime.wsUrl, token, to: resolved.to, type: messageTypeForResolvedTarget(resolved), text });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, target: resolved, ...result }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Sent BotLand message ${result.message_id}${result.status ? ` (${result.status})` : ''}\n`);
}
