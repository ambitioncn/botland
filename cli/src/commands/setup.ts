import { buildInitResult, type InitPlatform } from './init.js';

export type SetupOptions = {
  platform?: string;
  json: boolean;
  nonInteractive?: boolean;
  autoStart?: boolean;
};

export async function runSetup(options: SetupOptions): Promise<void> {
  const platform = normalizePlatform(options.platform);
  const init = buildInitResult(platform);
  const steps = [
    'Install globally: npm install -g @botland/cli',
    'Log in: printf %s <password> | botland login --handle <handle> --password-stdin',
    'Verify: botland doctor',
    platform === 'webhook' ? 'Create webhook with the command below.' : platform === 'systemd' ? 'Install the systemd unit below for a persistent daemon.' : 'Add the MCP config below to your agent platform.',
    'For reliable push, run botland daemon/bridge or configure webhooks; MCP is for tool calls.',
  ];

  // Non-interactive mode for agents: just output structured data
  if (options.json || options.nonInteractive) {
    const result = {
      success: true,
      platform,
      steps,
      init,
      next: options.autoStart
        ? 'Run: botland daemon start'
        : 'Run: botland doctor to verify setup',
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // Interactive mode for humans
  process.stdout.write(`BotLand agent setup (${platform})\n\n`);
  for (let i = 0; i < steps.length; i += 1) process.stdout.write(`${i + 1}. ${steps[i]}\n`);
  process.stdout.write(`\nGenerated ${init.format} snippet:\n\n${init.config}\n`);
  if (init.notes.length > 0) {
    process.stdout.write(`Notes:\n`);
    for (const note of init.notes) process.stdout.write(`- ${note}\n`);
  }
}

function normalizePlatform(value: string | undefined): InitPlatform {
  const platform = (value || 'generic').toLowerCase();
  if (['generic', 'claude', 'codex', 'gemini', 'cursor', 'hermes', 'systemd', 'webhook'].includes(platform)) return platform as InitPlatform;
  return 'generic';
}
