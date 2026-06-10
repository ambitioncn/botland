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
  activeAgent?: string;
  profiles?: Record<string, BotLandAgentProfile>;
};

export type BotLandAgentProfile = Omit<BotLandConfig, 'activeAgent' | 'profiles'>;

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

export function selectedAgent(): string | undefined {
  const raw = process.env.BOTLAND_AGENT || process.env.BOTLAND_PROFILE;
  const value = raw?.trim();
  return value || undefined;
}

export function sanitizeAgentEnvSuffix(agent: string): string {
  return agent
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'AGENT';
}

export function readSelectedProfile(config: BotLandConfig, agent = selectedAgent()): { agent?: string; profile: BotLandAgentProfile } {
  if (!agent) return { profile: config };
  const profile = config.profiles?.[agent];
  if (!profile) {
    throw new CliError(`BotLand agent profile "${agent}" was not found in ${defaultConfigPath()}. Run: botland --agent ${agent} login --token <token>`, {
      code: 'AGENT_PROFILE_NOT_FOUND',
      exitCode: 2,
    });
  }
  return { agent, profile };
}

export async function updateSelectedProfile(agent: string | undefined, patch: BotLandAgentProfile, path = defaultConfigPath()): Promise<BotLandConfig> {
  const current = await loadConfig(path);
  if (!agent) {
    const next = { ...current, ...patch };
    await saveConfig(next, path);
    return next;
  }
  const profiles = { ...(current.profiles ?? {}) };
  profiles[agent] = { ...(profiles[agent] ?? {}), ...patch };
  const next = { ...current, activeAgent: agent, profiles };
  await saveConfig(next, path);
  return next;
}

export async function resolveRuntimeConfig(): Promise<{ baseUrl: string; wsUrl: string; token?: string; configPath: string }> {
  const configPath = defaultConfigPath();
  const config = await loadConfig(configPath);
  const agent = selectedAgent();
  const tokenEnv = agent ? process.env[`BOTLAND_TOKEN_${sanitizeAgentEnvSuffix(agent)}`] : undefined;
  const globalTokenEnv = process.env.BOTLAND_TOKEN;
  const profile = agent && (tokenEnv || globalTokenEnv) && !config.profiles?.[agent]
    ? {}
    : readSelectedProfile(config, agent).profile;
  const baseUrl = (process.env.BOTLAND_BASE_URL || profile.baseUrl || config.baseUrl || 'https://api.botland.im').replace(/\/+$/, '');
  const wsUrl = (process.env.BOTLAND_WS_URL || profile.wsUrl || config.wsUrl || deriveWsUrl(baseUrl)).replace(/\/+$/, '');
  let token = tokenEnv || globalTokenEnv || profile.token;
  if (!tokenEnv && !globalTokenEnv && shouldRefreshToken(profile)) {
    const refreshed = await refreshToken(baseUrl, profile.refreshToken as string);
    token = refreshed.access_token;
    const expiresAt = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : undefined;
    await updateSelectedProfile(agent, {
      baseUrl,
      wsUrl,
      token: refreshed.access_token,
      refreshToken: refreshed.refresh_token || profile.refreshToken,
      citizenId: refreshed.citizen_id,
      handle: refreshed.handle,
      citizenType: refreshed.citizen_type,
      expiresAt,
    }, configPath);
  }
  return { baseUrl, wsUrl, token, configPath };
}

type RefreshResponse = {
  citizen_id: string;
  handle: string;
  citizen_type: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

function shouldRefreshToken(config: BotLandConfig): boolean {
  if (!config.refreshToken) return false;
  if (!config.token) return true;
  if (!config.expiresAt) return false;
  const expiresAt = Date.parse(config.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - Date.now() < 5 * 60 * 1000;
}

async function refreshToken(baseUrl: string, refreshTokenValue: string): Promise<RefreshResponse> {
  const url = new URL('/api/v1/auth/refresh', baseUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshTokenValue }),
    });
  } catch (error) {
    throw new CliError(`Failed to refresh BotLand token at ${url.origin}: ${(error as Error).message}`, { code: 'NETWORK_ERROR' });
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    throw new CliError('BotLand refresh API returned invalid JSON', { code: 'INVALID_API_JSON' });
  }
  if (!response.ok) {
    const body = data as { error?: { code?: string; message?: string }; code?: string; message?: string } | undefined;
    const message = body?.error?.message || body?.message || response.statusText || 'BotLand token refresh failed';
    const code = body?.error?.code || body?.code || `HTTP_${response.status}`;
    throw new CliError(message, { code, exitCode: response.status === 401 ? 3 : 1 });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CliError('BotLand refresh API returned an invalid token response', { code: 'INVALID_API_JSON' });
  }
  const body = data as Partial<RefreshResponse>;
  if (!body.access_token || !body.citizen_id || !body.handle || !body.citizen_type) {
    throw new CliError('BotLand refresh API returned an incomplete token response', { code: 'INVALID_API_JSON' });
  }
  return data as RefreshResponse;
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
