import { BotLandClient } from '../client/botland-client.js';
import type { Group, GroupMessage, MessagePayload } from '../client/types.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type GroupsOptions = {
  subcommand?: string;
  id?: string;
  name?: string;
  description?: string;
  announcement?: string;
  avatarUrl?: string;
  members?: string;
  citizenId?: string;
  role?: string;
  muted?: boolean;
  limit?: number;
  before?: string;
  json: boolean;
};

export async function runGroups(options: GroupsOptions): Promise<void> {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });
  const sub = options.subcommand || 'list';

  if (sub === 'list') return printResult(options, await client.listGroups(), formatGroups);
  if (sub === 'create') {
    if (!options.name) throw new CliError('groups create requires --name <name>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.createGroup({ name: options.name, description: options.description, memberIds: parseCsv(options.members) }), (group) => `Created group ${(group as Group).id || ''} (${(group as Group).name})\n`);
  }

  const groupId = requireGroupId(options);
  if (sub === 'get' || sub === 'show') return printResult(options, await client.getGroup(groupId), formatGroup);
  if (sub === 'update') {
    const patch: Record<string, unknown> = {};
    if (options.name !== undefined) patch.name = options.name;
    if (options.description !== undefined) patch.description = options.description;
    if (options.announcement !== undefined) patch.announcement = options.announcement;
    if (options.avatarUrl !== undefined) patch.avatar_url = options.avatarUrl;
    if (options.muted !== undefined) patch.muted_all = options.muted;
    if (Object.keys(patch).length === 0) throw new CliError('groups update requires at least one field flag', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.updateGroup(groupId, patch), () => `Updated group ${groupId}\n`);
  }
  if (sub === 'invite') {
    const citizenIds = parseCsv(options.members || options.citizenId);
    if (citizenIds.length === 0) throw new CliError('groups invite requires --members <citizen_id[,citizen_id...]>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.inviteGroupMembers(groupId, citizenIds), () => `Invited ${citizenIds.length} member(s) to ${groupId}\n`);
  }
  if (sub === 'remove') {
    if (!options.citizenId) throw new CliError('groups remove requires --citizen-id <citizen_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.removeGroupMember(groupId, options.citizenId), () => `Removed ${options.citizenId} from ${groupId}\n`);
  }
  if (sub === 'role') {
    if (!options.citizenId || !options.role) throw new CliError('groups role requires --citizen-id <citizen_id> --role admin|member', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.updateGroupMemberRole(groupId, options.citizenId, options.role), () => `Updated ${options.citizenId} role to ${options.role}\n`);
  }
  if (sub === 'leave') return printResult(options, await client.leaveGroup(groupId), () => `Left group ${groupId}\n`);
  if (sub === 'disband' || sub === 'delete') return printResult(options, await client.disbandGroup(groupId), () => `Disbanded group ${groupId}\n`);
  if (sub === 'transfer') {
    if (!options.citizenId) throw new CliError('groups transfer requires --citizen-id <citizen_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    return printResult(options, await client.transferGroup(groupId, options.citizenId), () => `Transferred ${groupId} to ${options.citizenId}\n`);
  }
  if (sub === 'mute') return printResult(options, await client.muteGroupAll(groupId, options.muted ?? true), () => `Updated mute-all for ${groupId}\n`);
  if (sub === 'messages' || sub === 'history') return printResult(options, await client.getGroupMessages({ groupId, limit: options.limit, before: options.before }), formatMessages);

  throw new CliError(`Unknown groups subcommand: ${sub}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function requireGroupId(options: GroupsOptions): string {
  const id = options.id?.trim();
  if (!id) throw new CliError(`groups ${options.subcommand || ''} requires <group_id>`, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return id;
}

function parseCsv(value?: string): string[] {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function printResult<T>(options: GroupsOptions, data: T, format: (data: T) => string): void {
  process.stdout.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : format(data));
}

function formatGroups(groups: Group[]): string {
  if (groups.length === 0) return 'No groups.\n';
  return groups.map((group) => `${group.id}\t${group.name}\t${group.member_count ?? 0} member(s)`).join('\n') + '\n';
}

function formatGroup(group: Group): string {
  const members = group.members?.map((member) => `  - ${member.citizen_id} ${member.display_name || ''} (${member.role})`).join('\n') || '';
  return `${group.name} (${group.id})\n${group.description || ''}\nMembers: ${group.member_count ?? group.members?.length ?? 0}\n${members ? `${members}\n` : ''}`;
}

function formatMessages(messages: GroupMessage[]): string {
  if (messages.length === 0) return 'No group messages.\n';
  return messages.slice().reverse().map((message) => {
    const payload = message.payload as MessagePayload | undefined;
    const text = payload?.text || payload?.media_url || payload?.url || JSON.stringify(payload ?? {});
    return `[${message.created_at}] ${message.sender_name || message.sender_id}: ${text}`;
  }).join('\n') + '\n';
}
