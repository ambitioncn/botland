import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type EventsOptions = {
  subcommand?: string;
  id?: string;
  cursor?: string;
  days?: number;
  limit?: number;
  json: boolean;
};

export async function runEvents(options: EventsOptions): Promise<void> {
  const subcommand = options.subcommand ?? 'list';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });

  if (subcommand === 'list') {
    const response = await client.listEvents({ cursor: options.cursor, limit: options.limit });
    if (options.json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else if (response.events.length === 0) process.stdout.write('No durable events.\n');
    else {
      for (const event of response.events) {
        process.stdout.write(`${event.id}\t${event.event_type}\t${event.created_at}${event.acked_at ? '\tacked' : ''}\n`);
      }
      if (response.next_cursor) process.stdout.write(`next_cursor: ${response.next_cursor}\n`);
    }
    return;
  }

  if (subcommand === 'ack') {
    if (!options.id) throw new CliError('events ack requires <event_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const response = await client.ackEvent(options.id);
    if (options.json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else process.stdout.write(`Acked event ${options.id}.\n`);
    return;
  }

  if (subcommand === 'cleanup') {
    const response = await client.cleanupEventsRetention({ days: options.days, limit: options.limit });
    if (options.json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else process.stdout.write(`Cleaned ${response.deleted} acked BotLand events older than ${response.days} days.\n`);
    return;
  }

  throw new CliError(`Unsupported events subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}
