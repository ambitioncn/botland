import { BotLandClient } from './botland-client.js';
import type { CitizenProfile, Friend } from './types.js';
import { CliError } from '../util/errors.js';

export type ResolvedTarget = {
  raw: string;
  isGroup: boolean;
  to: string;
  resolvedFrom?: 'id' | 'group' | 'search' | 'friends';
};

export async function resolveMessageTarget(client: BotLandClient, rawTarget: string): Promise<ResolvedTarget> {
  const raw = rawTarget.trim();
  if (!raw) throw new CliError('send requires --to <citizen_id|handle|display_name|group:group_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });

  if (raw.startsWith('group:')) return { raw, isGroup: true, to: raw.slice('group:'.length), resolvedFrom: 'group' };
  if (raw.startsWith('group_')) return { raw, isGroup: true, to: raw, resolvedFrom: 'group' };
  if (isLikelyCitizenId(raw)) return { raw, isGroup: false, to: raw, resolvedFrom: 'id' };

  const search = await client.searchCitizens(raw);
  const searchMatch = pickUniqueMatch(search.results, raw);
  if (searchMatch) return { raw, isGroup: false, to: searchMatch, resolvedFrom: 'search' };

  const friends = await client.listFriends();
  const friendMatch = pickUniqueMatch(friends.friends, raw);
  if (friendMatch) return { raw, isGroup: false, to: friendMatch, resolvedFrom: 'friends' };

  throw new CliError(`BotLand citizen not found for target: ${raw}`, { code: 'TARGET_NOT_FOUND', exitCode: 2 });
}

export function messageTypeForResolvedTarget(target: ResolvedTarget): 'message.send' | 'group.message.send' {
  return target.isGroup ? 'group.message.send' : 'message.send';
}

function isLikelyCitizenId(value: string): boolean {
  return /^(agent|human|user|ctz)_[A-Za-z0-9]+$/.test(value);
}

function pickUniqueMatch(items: Array<CitizenProfile | Friend>, query: string): string | null {
  const comparable = normalizeComparableIdentity(query);
  const matches = items.filter((item) => {
    const id = typeof item.citizen_id === 'string' ? item.citizen_id.trim() : '';
    if (!id) return false;
    const handle = normalizeComparableIdentity((item as { handle?: unknown }).handle);
    const name = normalizeComparableIdentity(item.display_name);
    return handle === comparable || name === comparable;
  });
  if (matches.length === 1) return matches[0].citizen_id;
  if (matches.length > 1) {
    const ids = matches.map((m) => m.citizen_id).join(', ');
    throw new CliError(`Multiple BotLand citizens matched target '${query}': ${ids}`, { code: 'AMBIGUOUS_TARGET', exitCode: 2 });
  }
  return null;
}

function normalizeComparableIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
}
