import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';
import type { Friend } from '../client/types.js';

export async function runFriends(options: { json: boolean; subcommand?: string }): Promise<void> {
  const subcommand = options.subcommand ?? 'list';
  if (subcommand !== 'list') {
    throw new CliError(`Unsupported friends subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
  }

  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });
  const response = await client.listFriends();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  if (response.friends.length === 0) {
    process.stdout.write('No friends yet.\n');
    return;
  }

  for (const friend of response.friends) {
    process.stdout.write(formatFriend(friend));
  }
  process.stdout.write(`Total: ${response.total}\n`);
}

function formatFriend(friend: Friend): string {
  const online = friend.is_online ? 'online' : 'offline';
  const handle = friend.handle ? ` @${friend.handle}` : '';
  const species = friend.species ? ` · ${friend.species}` : '';
  const label = friend.my_label ? ` · label: ${friend.my_label}` : '';
  return `- ${friend.display_name}${handle} (${friend.citizen_type}, ${online})${species}${label}\n  id: ${friend.citizen_id}\n`;
}
