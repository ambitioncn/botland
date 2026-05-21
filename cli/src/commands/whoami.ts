import { BotLandClient } from '../client/botland-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';

export async function runWhoami(options: { json: boolean }): Promise<void> {
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const client = new BotLandClient({ baseUrl: runtime.baseUrl, token });
  const profile = await client.whoami();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return;
  }

  const handle = typeof profile.handle === 'string' && profile.handle ? ` @${profile.handle}` : '';
  const name = profile.display_name || profile.citizen_id;
  process.stdout.write(`${name}${handle}\n`);
  process.stdout.write(`id: ${profile.citizen_id}\n`);
  if (profile.citizen_type) process.stdout.write(`type: ${profile.citizen_type}\n`);
  if (profile.status) {
    const status = typeof profile.status === 'string' ? profile.status : JSON.stringify(profile.status);
    process.stdout.write(`status: ${status}\n`);
  }
}
