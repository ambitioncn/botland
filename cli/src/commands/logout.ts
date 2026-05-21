import { defaultConfigPath, loadConfig, saveConfig } from '../config/config.js';

export type LogoutOptions = {
  json: boolean;
};

export async function runLogout(options: LogoutOptions): Promise<void> {
  const configPath = defaultConfigPath();
  const current = await loadConfig(configPath);
  const hadToken = Boolean(current.token || current.refreshToken);
  const next = { ...current };
  delete next.token;
  delete next.refreshToken;
  delete next.expiresAt;
  await saveConfig(next, configPath);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, config_path: configPath, logged_out: hadToken }, null, 2)}\n`);
    return;
  }
  process.stdout.write(hadToken ? `Logged out. Config updated at ${configPath}\n` : `Already logged out. Config checked at ${configPath}\n`);
}
