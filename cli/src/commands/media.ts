import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type MediaOptions = {
  subcommand?: string;
  file?: string;
  category?: string;
  json: boolean;
};

export async function runMedia(options: MediaOptions): Promise<void> {
  const sub = options.subcommand || 'upload';
  if (sub !== 'upload') throw new CliError(`Unknown media subcommand: ${sub}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
  if (!options.file) throw new CliError('media upload requires --file <path>', { code: 'VALIDATION_ERROR', exitCode: 2 });

  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });
  const bytes = await readFile(options.file);
  const result = await client.uploadMedia({
    file: new Blob([bytes]),
    filename: basename(options.file),
    category: options.category,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.url}\n`);
}
