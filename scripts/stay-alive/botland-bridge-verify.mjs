#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { probeBotlandCapabilities } from './botland-adapter/capabilities.mjs';
import { BOTLAND_INTENTS } from './botland-adapter/contract.mjs';
import { runBotlandIntent } from './botland-adapter/cli-driver.mjs';

const WORKSPACE = process.cwd();
const MIN_CLI_VERSION = '0.1.0-alpha.10';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    healthUrl: 'http://127.0.0.1:3100/health',
    requireLive: false,
    allowPollingFallback: false,
    pollingLimit: 20,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--health-url') args.healthUrl = argv[++i];
    else if (arg === '--require-live') args.requireLive = true;
    else if (arg === '--allow-polling-fallback') args.allowPollingFallback = true;
    else if (arg === '--polling-limit') args.pollingLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.pollingLimit) || args.pollingLimit < 1) {
    throw new Error('--polling-limit must be a positive integer');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/botland-bridge-verify.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --health-url <url>    BotLand daemon health endpoint. Default: http://127.0.0.1:3100/health
  --require-live        Treat CLI/identity/daemon health issues as hard errors.
  --allow-polling-fallback
                        If durable events polling works, treat daemon WS health drift as review.
  --polling-limit <n>   Event polling fallback read limit. Default: 20
  --json                Print JSON instead of verification text.
  --help                Show this help.

This command is read-only. It verifies the BotLand CLI daemon bridge: CLI version,
whoami identity, and daemon health/websocket state. It never sends BotLand messages.
`);
}

function addIssue(issues, level, code, message) {
  issues.push({ level, code, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function runCommand(command, args, timeoutMs = 10000) {
  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH ?? ''}`
  };
  const result = spawnSync(command, args, {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: timeoutMs,
    env
  });

  return {
    command: [command, ...args].join(' '),
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? ''
  };
}

function sleepSeconds(seconds) {
  spawnSync('sleep', [String(seconds)], { encoding: 'utf8' });
}

function severity(args) {
  return args.requireLive ? 'error' : 'warning';
}

function parseVersion(text) {
  const match = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function versionTooLow(actual, minimum) {
  if (!actual) return true;
  const normalize = (version) => {
    const [main, pre = ''] = version.split('-', 2);
    return {
      numbers: main.split('.').map((part) => Number.parseInt(part, 10)),
      pre
    };
  };
  const left = normalize(actual);
  const right = normalize(minimum);
  for (let i = 0; i < 3; i += 1) {
    const a = Number.isInteger(left.numbers[i]) ? left.numbers[i] : 0;
    const b = Number.isInteger(right.numbers[i]) ? right.numbers[i] : 0;
    if (a !== b) return a < b;
  }
  if (left.pre === right.pre) return false;
  if (!left.pre) return false;
  if (!right.pre) return true;
  return left.pre.localeCompare(right.pre) < 0;
}

function loadLifeState(args, issues) {
  const lifeStatePath = path.join(args.runtimeRoot, args.agent, 'life_state.json');
  if (!existsSync(lifeStatePath)) {
    addIssue(issues, 'error', 'life_state_missing', `Missing life_state.json: ${lifeStatePath}`);
    return { lifeStatePath, lifeState: null };
  }
  try {
    return { lifeStatePath, lifeState: readJson(lifeStatePath) };
  } catch (error) {
    addIssue(issues, 'error', 'life_state_json_invalid', error instanceof Error ? error.message : String(error));
    return { lifeStatePath, lifeState: null };
  }
}

function parseWhoami(output, issues, args, expectedCitizenId) {
  if (!output.stdout) return null;
  try {
    const whoami = JSON.parse(output.stdout);
    const citizenId = whoami.citizen_id ?? whoami.citizenId ?? whoami.id ?? null;
    if (expectedCitizenId && citizenId !== expectedCitizenId) {
      addIssue(
        issues,
        severity(args),
        'botland_identity_mismatch',
        `botland whoami citizen_id ${citizenId ?? 'unknown'} does not match life_state ${expectedCitizenId}`
      );
    }
    return {
      citizen_id: citizenId,
      display_name: whoami.display_name ?? whoami.displayName ?? whoami.name ?? null,
      handle: whoami.handle ?? null
    };
  } catch (error) {
    addIssue(issues, severity(args), 'botland_whoami_json_invalid', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function parseHealth(output, issues, args, addIssues = true) {
  if (!output.stdout) return null;
  try {
    const health = JSON.parse(output.stdout);
    const healthy = health.status === 'healthy' || health.healthy === true;
    const websocketConnected = health.websocket_connected === true
      || health.websocketConnected === true
      || health.websocket?.connected === true;
    if (!healthy) {
      if (addIssues) addIssue(issues, severity(args), 'botland_daemon_unhealthy', 'BotLand daemon health endpoint is not healthy');
    }
    if (!websocketConnected) {
      if (addIssues) addIssue(issues, severity(args), 'botland_daemon_websocket_disconnected', 'BotLand daemon websocket is not connected');
    }
    return {
      status: health.status ?? null,
      healthy,
      websocket_connected: websocketConnected,
      raw_keys: Object.keys(health).sort()
    };
  } catch (error) {
    if (addIssues) addIssue(issues, severity(args), 'botland_health_json_invalid', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function checkHealth(args, issues) {
  let lastOutput = null;
  let lastParsed = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastOutput = runCommand('curl', ['-fsS', '--max-time', '5', args.healthUrl], 8000);
    if (lastOutput.status === 0 && !lastOutput.timed_out && !lastOutput.error) {
      const parsed = parseHealth(lastOutput, issues, args, false);
      lastParsed = parsed;
      if (parsed?.healthy === true && parsed?.websocket_connected === true) {
        return parsed;
      }
    }
    if (attempt < 3) sleepSeconds(1);
  }

  if (!lastOutput || lastOutput.status !== 0 || lastOutput.timed_out || lastOutput.error) {
    addIssue(issues, severity(args), 'botland_daemon_health_failed', lastOutput?.stderr || lastOutput?.error || `Health check failed: ${args.healthUrl}`);
    return null;
  }
  return parseHealth(lastOutput, issues, args, true) ?? lastParsed;
}

function checkPollingFallback(args) {
  if (!args.allowPollingFallback) {
    return {
      enabled: false,
      available: false,
      intent: BOTLAND_INTENTS.EVENTS_LIST,
      command: null,
      ok: false,
      status: null,
      event_count: 0,
      stderr_preview: ''
    };
  }
  let result = null;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attemptCount = attempt;
    result = runBotlandIntent(
      BOTLAND_INTENTS.EVENTS_LIST,
      { limit: args.pollingLimit },
      { timeoutMs: 25000, agent: args.agent }
    );
    if (result.ok === true) break;
    if (attempt < 3) sleepSeconds(1);
  }
  const events = Array.isArray(result.adapter?.normalized)
    ? result.adapter.normalized
    : Array.isArray(result.stdout_json?.events)
      ? result.stdout_json.events
      : [];
  return {
    enabled: true,
    available: result.ok === true,
    intent: BOTLAND_INTENTS.EVENTS_LIST,
    command: result.command,
    ok: result.ok === true,
    status: result.status,
    attempt_count: attemptCount,
    event_count: events.length,
    stderr_preview: result.stderr_preview ?? ''
  };
}

function buildReport(args) {
  const issues = [];
  const { lifeStatePath, lifeState } = loadLifeState(args, issues);
  const botland = isObject(lifeState?.botland) ? lifeState.botland : {};
  const expectedCitizenId = botland.citizen_id ?? null;
  if (botland.integration !== 'cli_daemon_bridge') {
    addIssue(issues, 'error', 'botland_integration_not_cli_daemon_bridge', 'life_state.botland.integration must be cli_daemon_bridge');
  }

  const adapterCapabilities = probeBotlandCapabilities({ healthUrl: args.healthUrl, agent: args.agent });
  let cliVersion = adapterCapabilities.cli_version;
  if (!adapterCapabilities.commands.version.ok) {
    addIssue(issues, severity(args), 'botland_cli_version_failed', adapterCapabilities.commands.version.stderr_preview || 'botland --version failed');
  } else if (versionTooLow(cliVersion, MIN_CLI_VERSION)) {
    addIssue(issues, severity(args), 'botland_cli_version_too_low', `BotLand CLI ${cliVersion ?? 'unknown'} is below ${MIN_CLI_VERSION}`);
  }

  let whoami = null;
  if (!adapterCapabilities.commands.whoami.ok) {
    addIssue(issues, severity(args), 'botland_whoami_failed', adapterCapabilities.commands.whoami.stderr_preview || 'botland whoami failed');
  } else {
    whoami = adapterCapabilities.identity;
    if (expectedCitizenId && whoami.citizen_id !== expectedCitizenId) {
      addIssue(
        issues,
        severity(args),
        'botland_identity_mismatch',
        `botland whoami citizen_id ${whoami.citizen_id ?? 'unknown'} does not match life_state ${expectedCitizenId}`
      );
    }
  }

  const daemonHealth = adapterCapabilities.daemon_health;
  const pollingFallback = checkPollingFallback(args);
  const canFallbackToPolling = args.allowPollingFallback
    && pollingFallback.available === true
    && whoami?.citizen_id
    && (!expectedCitizenId || whoami.citizen_id === expectedCitizenId);
  if (!adapterCapabilities.commands.daemon_health.ok) {
    addIssue(
      issues,
      canFallbackToPolling ? 'warning' : severity(args),
      canFallbackToPolling ? 'botland_daemon_health_failed_polling_fallback' : 'botland_daemon_health_failed',
      adapterCapabilities.commands.daemon_health.stderr_preview || `Health check failed: ${args.healthUrl}`
    );
  } else {
    if (!daemonHealth.healthy) {
      addIssue(
        issues,
        canFallbackToPolling ? 'warning' : severity(args),
        canFallbackToPolling ? 'botland_daemon_unhealthy_polling_fallback' : 'botland_daemon_unhealthy',
        canFallbackToPolling
          ? 'BotLand daemon health endpoint is not healthy; durable events polling fallback is available'
          : 'BotLand daemon health endpoint is not healthy'
      );
    }
    if (!daemonHealth.websocket_connected) {
      addIssue(
        issues,
        canFallbackToPolling ? 'warning' : severity(args),
        canFallbackToPolling ? 'botland_daemon_websocket_disconnected_polling_fallback' : 'botland_daemon_websocket_disconnected',
        canFallbackToPolling
          ? 'BotLand daemon websocket is not connected; durable events polling fallback is available'
          : 'BotLand daemon websocket is not connected'
      );
    }
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');

  return {
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    health_url: args.healthUrl,
    require_live: args.requireLive,
    allow_polling_fallback: args.allowPollingFallback,
    minimum_cli_version: MIN_CLI_VERSION,
    adapter_capabilities: adapterCapabilities,
    polling_fallback: pollingFallback,
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    cli_version: cliVersion,
    expected_citizen_id: expectedCitizenId,
    whoami,
    daemon_health: daemonHealth,
    identity_mismatch_count: issues.filter((issue) => issue.code === 'botland_identity_mismatch').length,
    cli_version_error_count: issues.filter((issue) => issue.code === 'botland_cli_version_failed' || issue.code === 'botland_cli_version_too_low').length,
    daemon_health_error_count: issues.filter((issue) => issue.code === 'botland_daemon_health_failed' || issue.code === 'botland_daemon_unhealthy').length,
    websocket_disconnected_count: issues.filter((issue) => issue.code === 'botland_daemon_websocket_disconnected').length,
    polling_fallback_warning_count: issues.filter((issue) => issue.code.endsWith('_polling_fallback')).length,
    errors,
    warnings
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive BotLand bridge verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${boolLabel(report.read_only)}`);
  lines.push(`require_live: ${boolLabel(report.require_live)}`);
  lines.push(`allow_polling_fallback: ${boolLabel(report.allow_polling_fallback)}`);
  lines.push(`health_url: ${report.health_url}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${boolLabel(report.pass)}`);
  lines.push(`- errors: ${report.error_count}`);
  lines.push(`- warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('BotLand');
  lines.push(`- cli_version: ${report.cli_version ?? 'unknown'}`);
  lines.push(`- minimum_cli_version: ${report.minimum_cli_version}`);
  lines.push(`- expected_citizen_id: ${report.expected_citizen_id ?? 'unknown'}`);
  lines.push(`- whoami_citizen_id: ${report.whoami?.citizen_id ?? 'unknown'}`);
  lines.push(`- daemon_healthy: ${boolLabel(report.daemon_health?.healthy)}`);
  lines.push(`- websocket_connected: ${boolLabel(report.daemon_health?.websocket_connected)}`);
  lines.push(`- polling_fallback_available: ${boolLabel(report.polling_fallback?.available)}`);
  lines.push(`- identity_mismatch_count: ${report.identity_mismatch_count}`);
  lines.push(`- cli_version_error_count: ${report.cli_version_error_count}`);
  lines.push(`- daemon_health_error_count: ${report.daemon_health_error_count}`);
  lines.push(`- websocket_disconnected_count: ${report.websocket_disconnected_count}`);
  lines.push(`- polling_fallback_warnings: ${report.polling_fallback_warning_count}`);

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) lines.push(`- ${issue.code}: ${issue.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) lines.push(`- ${issue.code}: ${issue.message}`);
  }

  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatText(report));
  }
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
