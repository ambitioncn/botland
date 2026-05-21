import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type EventsOptions = {
  subcommand?: string;
  days?: number;
  limit?: number;
  json: boolean;
};

export async function runEvents(options: EventsOptions): Promise<void> {
  const subcommand = options.subcommand ?? 'help';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });

  if (subcommand === 'cleanup') {
    const response = await client.cleanupEventsRetention({ days: options.days, limit: options.limit });
    if (options.json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else process.stdout.write(`Cleaned ${response.deleted} acked BotLand events older than ${response.days} days.\n`);
    return;
  }

  throw new CliError(`Unsupported events subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}
