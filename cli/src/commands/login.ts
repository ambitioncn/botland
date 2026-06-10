import { readFileSync } from 'node:fs';

import { BotLandClient } from '../client/botland-client.js';
import { defaultConfigPath, deriveWsUrl, loadConfig, selectedAgent, updateSelectedProfile } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type LoginOptions = {
  handle?: string;
  password?: string;
  passwordStdin: boolean;
  token?: string;
  json: boolean;
};

export async function runLogin(options: LoginOptions): Promise<void> {
  const configPath = defaultConfigPath();
  const current = await loadConfig(configPath);
  const agent = selectedAgent();
  const currentProfile = agent ? current.profiles?.[agent] : current;
  const baseUrl = (process.env.BOTLAND_BASE_URL || currentProfile?.baseUrl || current.baseUrl || 'https://api.botland.im').replace(/\/+$/, '');
  const wsUrl = (process.env.BOTLAND_WS_URL || currentProfile?.wsUrl || current.wsUrl || deriveWsUrl(baseUrl)).replace(/\/+$/, '');

  if (options.token) {
    const token = options.token.trim();
    if (!token) throw new CliError('--token cannot be empty', { code: 'VALIDATION_ERROR', exitCode: 2 });
    const client = new BotLandClient({ baseUrl, token });
    const profile = await client.whoami();
    await updateSelectedProfile(agent, {
      baseUrl,
      wsUrl,
      token,
      refreshToken: undefined,
      expiresAt: undefined,
      citizenId: profile.citizen_id,
      handle: typeof profile.handle === 'string' ? profile.handle : undefined,
      citizenType: typeof profile.citizen_type === 'string' ? profile.citizen_type : undefined,
    }, configPath);
    printLoginResult({ json: options.json, configPath, agent, handle: profile.handle, citizenId: profile.citizen_id });
    return;
  }

  const handle = options.handle?.trim();
  if (!handle) throw new CliError('login requires --handle <handle> or --token <token>', { code: 'VALIDATION_ERROR', exitCode: 2 });
  const password = options.passwordStdin ? readStdin().trimEnd() : options.password;
  if (!password) throw new CliError('login requires --password-stdin or --password <password>', { code: 'VALIDATION_ERROR', exitCode: 2 });

  const client = new BotLandClient({ baseUrl });
  const auth = await client.login(handle, password);
  const expiresAt = auth.expires_in ? new Date(Date.now() + auth.expires_in * 1000).toISOString() : undefined;
  await updateSelectedProfile(agent, {
    baseUrl,
    wsUrl,
    token: auth.access_token,
    refreshToken: auth.refresh_token,
    citizenId: auth.citizen_id,
    handle: auth.handle,
    citizenType: auth.citizen_type,
    expiresAt,
  }, configPath);

  printLoginResult({ json: options.json, configPath, agent, handle: auth.handle, citizenId: auth.citizen_id });
}

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

function printLoginResult(options: { json: boolean; configPath: string; agent?: string; handle?: string; citizenId: string }): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, config_path: options.configPath, agent: options.agent, handle: options.handle, citizen_id: options.citizenId }, null, 2)}\n`);
    return;
  }
  const who = options.handle ? `@${options.handle}` : options.citizenId;
  process.stdout.write(`Logged in as ${who}${options.agent ? ` for agent profile ${options.agent}` : ''}\n`);
  process.stdout.write(`Config saved to ${options.configPath}\n`);
}
