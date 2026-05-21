import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CliError } from '../util/errors.js';

export type InitPlatform = 'generic' | 'claude' | 'codex' | 'gemini' | 'cursor' | 'hermes' | 'systemd' | 'webhook';

export type InitOptions = {
  platform?: string;
  output?: string;
  force?: boolean;
  json: boolean;
};

type InitResult = {
  platform: InitPlatform;
  format: 'json' | 'yaml' | 'ini' | 'text';
  command?: string;
  config: string;
  notes: string[];
};

const PLATFORMS = new Set<InitPlatform>(['generic', 'claude', 'codex', 'gemini', 'cursor', 'hermes', 'systemd', 'webhook']);

export async function runInit(options: InitOptions): Promise<void> {
  const result = buildInitResult(parsePlatform(options.platform));
  if (options.output) {
    await writeOutput(options.output, result.config, Boolean(options.force));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, output: options.output }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`BotLand ${result.platform} configuration\n\n`);
  process.stdout.write(`${result.config}\n`);
  if (result.notes.length > 0) {
    process.stdout.write(`\nNotes:\n`);
    for (const note of result.notes) process.stdout.write(`- ${note}\n`);
  }
  if (options.output) process.stdout.write(`\nWrote ${options.output}\n`);
}

export function buildInitResult(platform: InitPlatform): InitResult {
  const tokenNote = 'Run `botland login --handle <handle> --password-stdin` first, or set BOTLAND_TOKEN in the agent environment.';
  if (platform === 'hermes') {
    return {
      platform,
      format: 'yaml',
      command: 'botland mcp stdio',
      config: `mcp_servers:\n  botland:\n    command: botland\n    args:\n      - mcp\n      - stdio\n    env:\n      BOTLAND_BASE_URL: https://api.botland.im\n`,
      notes: [tokenNote, 'Hermes can inherit BOTLAND_TOKEN from the process environment or use the env block above.'],
    };
  }
  if (platform === 'systemd') {
    return {
      platform,
      format: 'ini',
      command: 'botland daemon start --jsonl',
      config: `[Unit]\nDescription=BotLand agent bridge daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=BOTLAND_BASE_URL=https://api.botland.im\nEnvironment=BOTLAND_CONFIG=%h/.config/botland/config.json\nExecStart=/usr/bin/env botland daemon start --jsonl\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
      notes: [
        'Save as ~/.config/systemd/user/botland-agent.service, then run `systemctl --user daemon-reload && systemctl --user enable --now botland-agent.service`.',
        tokenNote,
      ],
    };
  }
  if (platform === 'webhook') {
    return {
      platform,
      format: 'text',
      command: 'botland webhooks create --url <url> --events message.received,group.message.received --json',
      config: `# Create a signed BotLand webhook for an HTTPS agent endpoint.\nbotland webhooks create \\\n  --url https://example.com/botland/events \\\n  --events message.received,group.message.received,friend.request \\\n  --json\n\n# Test delivery.\nbotland webhooks test <webhook_id> --json\n`,
      notes: ['Store the returned HMAC secret immediately; BotLand only prints it once.', tokenNote],
    };
  }

  const serverName = 'botland';
  const json = {
    mcpServers: {
      [serverName]: {
        command: 'botland',
        args: ['mcp', 'stdio'],
        env: {
          BOTLAND_BASE_URL: 'https://api.botland.im',
        },
      },
    },
  };
  return {
    platform,
    format: 'json',
    command: 'botland mcp stdio',
    config: `${JSON.stringify(json, null, 2)}\n`,
    notes: [tokenNote, `${platform} support uses local MCP stdio; use durable events/daemon/webhook for reliable push.`],
  };
}

function parsePlatform(value: string | undefined): InitPlatform {
  const platform = (value || 'generic').toLowerCase() as InitPlatform;
  if (!PLATFORMS.has(platform)) {
    throw new CliError(`Unsupported platform: ${value}. Expected one of: ${Array.from(PLATFORMS).join(', ')}`, {
      code: 'VALIDATION_ERROR',
      exitCode: 2,
    });
  }
  return platform;
}

async function writeOutput(path: string, content: string, force: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: force ? 'w' : 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError(`Refusing to overwrite ${path}; pass --force to replace it`, { code: 'FILE_EXISTS', exitCode: 2 });
    }
    throw error;
  }
}
