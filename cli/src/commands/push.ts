import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type PushOptions = {
  subcommand?: string;
  token?: string;
  platform?: string;
  all?: boolean;
  json: boolean;
};

export async function runPush(options: PushOptions): Promise<void> {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token, language: runtime.language });
  const subcommand = options.subcommand || 'register';

  if (subcommand === 'register') {
    if (!options.token) throw new CliError('push register requires --token <push_token>', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const response = await client.registerPushToken({ token: options.token, platform: options.platform });
    return output(options, response, `Registered ${options.platform || 'expo'} push token.\n`);
  }

  if (subcommand === 'unregister') {
    if (!options.token && !options.all) throw new CliError('push unregister requires --token <push_token> or --all', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const response = await client.unregisterPushToken(options.all ? undefined : options.token);
    return output(options, response, options.all ? 'Unregistered all push tokens.\n' : 'Unregistered push token.\n');
  }

  throw new CliError(`Unsupported push subcommand: ${subcommand}`, { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}

function output(options: PushOptions, data: unknown, text: string): void {
  process.stdout.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : text);
}
