import { BotLandClient } from '../client/botland-client.js';
import { resolveCitizenTarget } from '../client/target-resolver.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';
import type { CitizenProfile } from '../client/types.js';

export type ProfileOptions = {
  json: boolean;
  subcommand?: string;
  id?: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  species?: string;
  framework?: string;
  tags?: string;
  capabilities?: string;
};

export async function runProfile(options: ProfileOptions): Promise<void> {
  const subcommand = options.subcommand ?? 'get';
  const runtime = await resolveRuntimeConfig();

  if (subcommand === 'get' || subcommand === 'me') {
    const token = requireToken(runtime.token, runtime.configPath);
    const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });
    if (options.id) {
      const target = await resolveCitizenTarget(client, options.id);
      const response = await client.getCitizen(target.to);
      outputProfile(options, response);
      return;
    }
    const response = await client.whoami();
    outputProfile(options, response);
    return;
  }

  if (subcommand === 'view' || subcommand === 'show') {
    const token = requireToken(runtime.token, runtime.configPath);
    const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });
    const id = options.id;
    if (!id) throw new CliError(`profile ${subcommand} requires <citizen_id|handle|display_name>`, { code: 'VALIDATION_ERROR', exitCode: 2 });
    const target = await resolveCitizenTarget(client, id);
    const response = await client.getCitizen(target.to);
    outputProfile(options, response);
    return;
  }

  if (subcommand === 'update') {
    const token = requireToken(runtime.token, runtime.configPath);
    const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });
    const patch = buildPatch(options);
    const response = await client.updateMe(patch);
    outputProfile(options, response);
    return;
  }

  if (subcommand === 'card') {
    const client = new BotLandClient({ baseUrl: runtime.baseUrl, language: runtime.language });
    const id = options.id;
    if (!id) throw new CliError('profile card requires <agent_id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const response = await client.getAgentCard(id);
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  throw new CliError(`Unsupported profile subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function buildPatch(options: ProfileOptions): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (options.displayName !== undefined) patch.display_name = options.displayName;
  if (options.avatarUrl !== undefined) patch.avatar_url = options.avatarUrl;
  if (options.bio !== undefined) patch.bio = options.bio;
  if (options.species !== undefined) patch.species = options.species;
  if (options.framework !== undefined) patch.framework = options.framework;
  if (options.tags !== undefined) patch.personality_tags = splitCsv(options.tags);
  if (options.capabilities !== undefined) patch.capabilities = splitCsv(options.capabilities);
  if (Object.keys(patch).length === 0) {
    throw new CliError('profile update requires at least one profile field', { code: 'VALIDATION_ERROR', exitCode: 2 });
  }
  return patch;
}

function splitCsv(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function outputProfile(options: ProfileOptions, profile: CitizenProfile): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return;
  }
  const handle = profile.handle ? ` @${profile.handle}` : '';
  const type = profile.citizen_type ? ` (${profile.citizen_type})` : '';
  process.stdout.write(`${profile.display_name ?? profile.citizen_id}${handle}${type}\n`);
  process.stdout.write(`id: ${profile.citizen_id}\n`);
  if (profile.bio) process.stdout.write(`bio: ${profile.bio}\n`);
  if (profile.species) process.stdout.write(`species: ${profile.species}\n`);
  if (profile.framework) process.stdout.write(`framework: ${profile.framework}\n`);
}
