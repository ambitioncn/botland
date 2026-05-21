import { BotLandClient } from '../client/botland-client.js';
import type { Webhook } from '../client/types.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type WebhooksOptions = {
  subcommand?: string;
  id?: string;
  url?: string;
  events?: string;
  days?: number;
  limit?: number;
  json: boolean;
};

export async function runWebhooks(options: WebhooksOptions): Promise<void> {
  const subcommand = options.subcommand ?? 'list';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });

  if (subcommand === 'create') {
    if (!options.url) throw new CliError('webhooks create requires --url', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const response = await client.createWebhook({ url: options.url, events: parseEvents(options.events) });
    output(options, response, `Created webhook ${response.id}\nURL: ${response.url}\nEvents: ${response.events.join(', ')}\nSecret: ${response.secret}\nKeep this secret; it is only shown on create.\n`);
    return;
  }

  if (subcommand === 'list') {
    const response = await client.listWebhooks();
    if (options.json) { process.stdout.write(`${JSON.stringify(response, null, 2)}\n`); return; }
    if (response.webhooks.length === 0) { process.stdout.write('No webhooks configured.\n'); return; }
    for (const webhook of response.webhooks) process.stdout.write(formatWebhook(webhook));
    process.stdout.write(`Total: ${response.total}\n`);
    return;
  }

  if (subcommand === 'test') {
    const id = requireID(options);
    const response = await client.testWebhook(id);
    output(options, response, `Webhook ${id} test ${response.status}${response.response_status ? ` (HTTP ${response.response_status})` : ''}\nAttempts: ${response.attempts}\n${response.error ? `Error: ${response.error}\n` : ''}`);
    return;
  }

  if (subcommand === 'rotate-secret') {
    const id = requireID(options);
    const response = await client.rotateWebhookSecret(id);
    output(options, response, `Rotated webhook ${id} secret.\nNew secret: ${response.secret}\nUpdate your receiver immediately; this secret is only shown now.\n`);
    return;
  }

  if (subcommand === 'cleanup-deliveries') {
    const response = await client.cleanupWebhookDeliveriesRetention({ days: options.days, limit: options.limit });
    output(options, response, `Cleaned ${response.deleted} terminal webhook deliveries older than ${response.days} days.\n`);
    return;
  }

  if (subcommand === 'delete') {
    const id = requireID(options);
    const response = await client.deleteWebhook(id);
    output(options, response, `Deleted webhook ${id}.\n`);
    return;
  }

  throw new CliError(`Unsupported webhooks subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function requireID(options: WebhooksOptions): string {
  if (!options.id) throw new CliError(`webhooks ${options.subcommand} requires <id>`, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return options.id;
}

function parseEvents(raw?: string): string[] {
  if (!raw) return ['*'];
  const events = raw.split(',').map((part) => part.trim()).filter(Boolean);
  return events.length > 0 ? events : ['*'];
}

function output(options: WebhooksOptions, data: unknown, text: string): void {
  if (options.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(text);
}

function formatWebhook(webhook: Webhook): string {
  const enabled = webhook.enabled ? 'enabled' : 'disabled';
  const last = webhook.last_success_at ? ` · last success: ${webhook.last_success_at}` : webhook.last_failure_at ? ` · last failure: ${webhook.last_failure_at}` : '';
  return `- ${webhook.id} (${enabled})${last}\n  url: ${webhook.url}\n  events: ${webhook.events.join(', ')}\n`;
}
