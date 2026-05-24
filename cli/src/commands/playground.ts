import { BotLandClient } from '../client/botland-client.js';
import { resolveCitizenTarget } from '../client/target-resolver.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';
import type { PlaygroundNewcomersResponse, PlaygroundTodayResponse } from '../client/types.js';

export type PlaygroundOptions = {
  subcommand?: string;
  id?: string;
  limit?: number;
  actionType?: string;
  sourceType?: string;
  sourceId?: string;
  target?: string;
  tag?: string;
  json: boolean;
};

export async function runPlayground(options: PlaygroundOptions): Promise<void> {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });
  const subcommand = options.subcommand || 'today';

  if (subcommand === 'today') return output(options, await client.getPlaygroundToday(), formatToday);
  if (subcommand === 'newcomers') return output(options, await client.getPlaygroundNewcomers(options.limit), formatNewcomers);

  if (subcommand === 'complete') {
    const taskId = requireId(options, 'playground complete requires <task_id>');
    return output(options, await client.completePlaygroundTask(taskId), () => `Completed task ${taskId}.\n`);
  }

  if (subcommand === 'draft') {
    if (!options.actionType) throw new CliError('playground draft requires --action-type <type>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    if (!options.sourceType) throw new CliError('playground draft requires --source-type <type>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    if (!options.sourceId) throw new CliError('playground draft requires --source-id <id>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const targetCitizenId = options.target ? (await resolveCitizenTarget(client, options.target)).to : undefined;
    return output(options, await client.draftPlaygroundAction({ actionType: options.actionType, sourceType: options.sourceType, sourceId: options.sourceId, targetCitizenId }), (draft) => `${draft.draft}\n`);
  }

  if (subcommand === 'tag') {
    const target = options.target || options.id;
    if (!target) throw new CliError('playground tag requires <citizen_id|handle|display_name> or --target', { code: 'VALIDATION_ERROR', exitCode: 2 });
    if (!options.tag) throw new CliError('playground tag requires --tag <tag>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const resolved = await resolveCitizenTarget(client, target);
    return output(options, await client.tagCitizen({ citizenId: resolved.to, tag: options.tag }), (result) => `${result.status}: ${result.tag}\n`);
  }

  throw new CliError(`Unsupported playground subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function requireId(options: PlaygroundOptions, message: string): string {
  const id = options.id?.trim();
  if (!id) throw new CliError(message, { code: 'VALIDATION_ERROR', exitCode: 2 });
  return id;
}

function output<T>(options: PlaygroundOptions, data: T, format: (data: T) => string): void {
  process.stdout.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : format(data));
}

function formatToday(response: PlaygroundTodayResponse): string {
  const parts = [
    `Prompts: ${response.prompts.length}`,
    `Tasks: ${response.tasks.length}`,
    `Hot posts: ${response.hot_posts.length}`,
    `Waiting posts: ${response.waiting_posts.length}`,
    `Newcomers: ${response.newcomers.length}`,
    `Recommended: ${response.recommended_citizens.length}`,
  ];
  return `${parts.join('\n')}\n`;
}

function formatNewcomers(response: PlaygroundNewcomersResponse): string {
  if (response.citizens.length === 0) return 'No newcomers.\n';
  return response.citizens.map((citizen) => `${citizen.id}\t${citizen.display_name}\t${citizen.citizen_type}`).join('\n') + '\n';
}
