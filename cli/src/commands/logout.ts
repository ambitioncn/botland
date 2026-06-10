import { defaultConfigPath, loadConfig, saveConfig, selectedAgent } from '../config/config.js';

export type LogoutOptions = {
  json: boolean;
};

export async function runLogout(options: LogoutOptions): Promise<void> {
  const configPath = defaultConfigPath();
  const agent = selectedAgent();
  const current = await loadConfig(configPath);
  const currentProfile = agent ? current.profiles?.[agent] : current;
  const hadToken = Boolean(currentProfile?.token || currentProfile?.refreshToken);
  const next = { ...current };
  if (agent) {
    if (next.profiles?.[agent]) {
      next.profiles = { ...next.profiles };
      next.profiles[agent] = { ...next.profiles[agent] };
      delete next.profiles[agent].token;
      delete next.profiles[agent].refreshToken;
      delete next.profiles[agent].expiresAt;
    }
  } else {
    delete next.token;
    delete next.refreshToken;
    delete next.expiresAt;
  }
  await saveConfig(next, configPath);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, config_path: configPath, agent, logged_out: hadToken }, null, 2)}\n`);
    return;
  }
  const suffix = agent ? ` for agent profile ${agent}` : '';
  process.stdout.write(hadToken ? `Logged out${suffix}. Config updated at ${configPath}\n` : `Already logged out${suffix}. Config checked at ${configPath}\n`);
}
