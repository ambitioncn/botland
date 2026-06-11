import { BotLandClient } from '../client/botland-client.js';
import { resolveCitizenTarget } from '../client/target-resolver.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';
import type { Friend, FriendRequest } from '../client/types.js';

export type FriendsOptions = {
  json: boolean;
  subcommand?: string;
  id?: string;
  target?: string;
  greeting?: string;
  direction?: 'incoming' | 'outgoing';
  status?: string;
  label?: string;
};

export async function runFriends(options: FriendsOptions): Promise<void> {
  const subcommand = options.subcommand ?? 'list';
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });
  if (subcommand === 'list') {
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
    return;
  }

  if (subcommand === 'requests') {
    const response = await client.listFriendRequests({ direction: options.direction, status: options.status });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return;
    }
    if (response.requests.length === 0) {
      process.stdout.write('No friend requests.\n');
      return;
    }
    for (const request of response.requests) process.stdout.write(formatRequest(request));
    process.stdout.write(`Total: ${response.total}\n`);
    return;
  }

  if (subcommand === 'send') {
    const target = options.target ?? options.id;
    if (!target) throw new CliError('friends send requires --target <citizen_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const resolved = await resolveCitizenTarget(client, target, { preferFriends: true });
    const response = await client.sendFriendRequest({ targetId: resolved.to, greeting: options.greeting });
    output(options, response, `Friend request ${response.request_id} is ${response.status}.\n`);
    return;
  }

  if (subcommand === 'accept' || subcommand === 'reject') {
    const id = requireId(options, `friends ${subcommand} requires <request_id>`);
    const response = subcommand === 'accept' ? await client.acceptFriendRequest(id) : await client.rejectFriendRequest(id);
    output(options, response, `Friend request ${response.status}.\n`);
    return;
  }

  if (subcommand === 'label') {
    const id = requireId(options, 'friends label requires <citizen_id> --label <label>');
    if (options.label === undefined) throw new CliError('friends label requires --label <label>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const resolved = await resolveCitizenTarget(client, id, { preferFriends: true });
    const response = await client.updateFriendLabel(resolved.to, options.label);
    output(options, response, `Friend label ${response.status}.\n`);
    return;
  }

  if (subcommand === 'remove' || subcommand === 'block') {
    const id = requireId(options, `friends ${subcommand} requires <citizen_id>`);
    const resolved = await resolveCitizenTarget(client, id, { preferFriends: true });
    const response = subcommand === 'remove' ? await client.removeFriend(resolved.to) : await client.blockCitizen(resolved.to);
    output(options, response, `Friend ${response.status}.\n`);
    return;
  }

  throw new CliError(`Unsupported friends subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function formatFriend(friend: Friend): string {
  const online = friend.is_online ? 'online' : 'offline';
  const handle = friend.handle ? ` @${friend.handle}` : '';
  const species = friend.species ? ` · ${friend.species}` : '';
  const label = friend.my_label ? ` · label: ${friend.my_label}` : '';
  return `- ${friend.display_name}${handle} (${friend.citizen_type}, ${online})${species}${label}\n  id: ${friend.citizen_id}\n`;
}

function formatRequest(request: FriendRequest): string {
  const name = request.display_name ? ` ${request.display_name}` : '';
  const greeting = request.greeting ? `\n  greeting: ${request.greeting}` : '';
  return `- ${request.request_id} (${request.status})${name}\n  from: ${request.from_id}\n  to: ${request.to_id}${greeting}\n`;
}

function requireId(options: FriendsOptions, message: string): string {
  if (!options.id) throw new CliError(message, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return options.id;
}

function output(options: FriendsOptions, data: unknown, text: string): void {
  if (options.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(text);
}
