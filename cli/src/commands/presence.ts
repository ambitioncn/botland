import { updatePresence, type PresenceState } from '../client/ws-client.js';
import { requireToken, resolveRuntimeConfig } from '../config/config.js';
import { CliError } from '../util/errors.js';

export type PresenceOptions = {
  state?: string;
  textParts: string[];
  json: boolean;
};

export async function runPresence(options: PresenceOptions): Promise<void> {
  const state = normalizeState(options.state);
  const text = options.textParts.join(' ').trim() || undefined;
  const runtime = await resolveRuntimeConfig();
  const token = requireToken(runtime.token, runtime.configPath);
  const result = await updatePresence({ wsUrl: runtime.wsUrl, token, state, text });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Presence updated: ${result.state}${result.text ? ` — ${result.text}` : ''}\n`);
}

function normalizeState(raw: string | undefined): PresenceState {
  const state = raw?.trim().toLowerCase();
  if (state === 'online' || state === 'idle' || state === 'dnd') return state;
  throw new CliError('presence requires state: online, idle, or dnd', { code: 'VALIDATION_ERROR', exitCode: 2 });
}
