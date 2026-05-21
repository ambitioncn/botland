import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { CliError } from '../util/errors.js';

export type BotLandConfig = {
  baseUrl?: string;
  token?: string;
  refreshToken?: string;
  wsUrl?: string;
  citizenId?: string;
  handle?: string;
  citizenType?: string;
  expiresAt?: string;
};

export function defaultConfigPath(): string {
  if (process.env.BOTLAND_CONFIG) return process.env.BOTLAND_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'botland', 'config.json');
}

export async function loadConfig(path = defaultConfigPath()): Promise<BotLandConfig> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError(`Invalid config file: ${path}`, { code: 'INVALID_CONFIG' });
    }
    return parsed as BotLandConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      throw new CliError(`Invalid JSON in config file: ${path}`, { code: 'INVALID_CONFIG' });
    }
    throw error;
  }
}

export async function saveConfig(config: BotLandConfig, path = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, path);
  await chmod(path, 0o600);
}

export async function updateConfig(patch: BotLandConfig, path = defaultConfigPath()): Promise<BotLandConfig> {
  const current = await loadConfig(path);
  const next = { ...current, ...patch };
  await saveConfig(next, path);
  return next;
}

export async function resolveRuntimeConfig(): Promise<{ baseUrl: string; wsUrl: string; token?: string; configPath: string }> {
  const configPath = defaultConfigPath();
  const config = await loadConfig(configPath);
  const baseUrl = (process.env.BOTLAND_BASE_URL || config.baseUrl || 'https://api.botland.im').replace(/\/+$/, '');
  const wsUrl = (process.env.BOTLAND_WS_URL || config.wsUrl || deriveWsUrl(baseUrl)).replace(/\/+$/, '');
  const token = process.env.BOTLAND_TOKEN || config.token;
  return { baseUrl, wsUrl, token, configPath };
}

export function deriveWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function requireToken(token: string | undefined, configPath: string): string {
  if (token && token.trim()) return token.trim();
  throw new CliError(
    `BotLand token is required. Set BOTLAND_TOKEN or add {"token":"..."} to ${configPath}.`,
    { code: 'MISSING_TOKEN', exitCode: 2 },
  );
}
