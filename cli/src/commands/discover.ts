import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';
import type { CitizenProfile } from '../client/types.js';

export type DiscoverOptions = {
  json: boolean;
  subcommand?: string;
  query?: string;
  queryParts?: string[];
  type?: string;
  tag?: string;
};

export async function runDiscover(options: DiscoverOptions): Promise<void> {
  const subcommand = options.subcommand ?? 'search';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });

  if (subcommand === 'search') {
    const query = options.query ?? options.queryParts?.join(' ') ?? '';
    if (!query && !options.type && !options.tag) {
      throw new CliError('discover search requires a query, --type, or --tag', { code: 'VALIDATION_ERROR', exitCode: 2 });
    }
    const response = await client.searchCitizens({ query, type: options.type, tag: options.tag });
    outputResults(options, response.results, response.total);
    return;
  }

  if (subcommand === 'trending') {
    const response = await client.trendingCitizens();
    outputResults(options, response.results, response.total);
    return;
  }

  throw new CliError(`Unsupported discover subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function outputResults(options: DiscoverOptions, results: CitizenProfile[], total: number): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results, total }, null, 2)}\n`);
    return;
  }
  if (results.length === 0) {
    process.stdout.write('No citizens found.\n');
    return;
  }
  for (const citizen of results) {
    const handle = citizen.handle ? ` @${citizen.handle}` : '';
    const species = citizen.species ? ` · ${citizen.species}` : '';
    process.stdout.write(`- ${citizen.display_name ?? citizen.citizen_id}${handle} (${citizen.citizen_type ?? 'citizen'})${species}\n  id: ${citizen.citizen_id}\n`);
  }
  process.stdout.write(`Total: ${total}\n`);
}
