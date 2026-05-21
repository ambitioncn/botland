import { access } from 'node:fs/promises';

import { BotLandClient } from '../client/botland-client.js';
import { defaultConfigPath, loadConfig, resolveRuntimeConfig } from '../config/config.js';

export type DoctorOptions = {
  json: boolean;
  offline?: boolean;
  requireToken?: boolean;
  autoFixScript?: boolean;
};

type Check = {
  name: string;
  ok: boolean;
  level: 'info' | 'warning' | 'error';
  message: string;
  fix?: string; // Executable fix command for agents
};

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0] || '0');
  checks.push({
    name: 'node',
    ok: nodeMajor >= 22,
    level: nodeMajor >= 22 ? 'info' : 'error',
    message: `Node.js ${process.versions.node} ${nodeMajor >= 22 ? 'is supported' : 'is too old; BotLand CLI requires >=22'}`,
  });

  const configPath = defaultConfigPath();
  try {
    await access(configPath);
    checks.push({ name: 'config', ok: true, level: 'info', message: `Config found at ${configPath}` });
  } catch {
    checks.push({ name: 'config', ok: true, level: 'warning', message: `Config not found at ${configPath}; run botland login` });
  }

  const config = await loadConfig(configPath);
  const runtime = await resolveRuntimeConfig();
  checks.push({ name: 'api_url', ok: true, level: 'info', message: `API URL: ${runtime.baseUrl}` });
  checks.push({ name: 'ws_url', ok: true, level: 'info', message: `WebSocket URL: ${runtime.wsUrl}` });

  const hasToken = Boolean(runtime.token?.trim());
  checks.push({
    name: 'token',
    ok: hasToken || !options.requireToken,
    level: hasToken ? 'info' : options.requireToken ? 'error' : 'warning',
    message: hasToken ? `Token configured${config.handle ? ` for @${config.handle}` : ''}` : 'No token configured; run botland login or set BOTLAND_TOKEN',
    fix: hasToken ? undefined : 'echo "BOTLAND_TOKEN=your_token_here" >> ~/.bashrc && source ~/.bashrc',
  });

  if (!options.offline && hasToken) {
    try {
      const profile = await new BotLandClient({ baseUrl: runtime.baseUrl, token: runtime.token }).whoami();
      checks.push({ name: 'whoami', ok: true, level: 'info', message: `Authenticated as ${profile.handle ? `@${profile.handle}` : profile.citizen_id}` });
    } catch (error) {
      checks.push({ name: 'whoami', ok: false, level: 'error', message: `Auth/API check failed: ${(error as Error).message}` });
    }
  } else if (options.offline) {
    checks.push({ name: 'online_check', ok: true, level: 'info', message: 'Skipped API auth check in offline mode' });
  }

  const ok = checks.every((check) => check.ok);
  const failed = checks.filter((c) => !c.ok && c.fix);

  if (options.json || options.autoFixScript) {
    const result: any = { ok, checks };
    if (options.autoFixScript && failed.length > 0) {
      const fixCommands = failed.map((c) => c.fix).filter(Boolean);
      result.fix_script = `#!/bin/bash\nset -e\n${fixCommands.join('\n')}\nbotland doctor --require-token`;
      result.next = 'Execute fix_script to resolve issues';
    } else if (!ok) {
      result.next = 'Fix the issues above and run: botland doctor';
    } else {
      result.next = 'All checks passed. Run: botland whoami to verify identity';
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`BotLand doctor\n\n`);
    for (const check of checks) {
      const mark = check.level === 'error' ? '✗' : check.level === 'warning' ? '!' : '✓';
      process.stdout.write(`${mark} ${check.name}: ${check.message}\n`);
      if (!check.ok && check.fix) {
        process.stdout.write(`  Fix: ${check.fix}\n`);
      }
    }
  }
  if (!ok) process.exitCode = 1;
}
