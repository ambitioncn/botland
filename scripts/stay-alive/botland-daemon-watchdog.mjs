#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    healthUrl: 'http://127.0.0.1:3100/health',
    service: 'botland-daemon.service',
    cooldownMinutes: 2,
    dryRun: false,
    confirmRestart: null,
    record: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--health-url') args.healthUrl = argv[++i];
    else if (arg === '--service') args.service = argv[++i];
    else if (arg === '--cooldown-minutes') args.cooldownMinutes = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--confirm-restart') args.confirmRestart = argv[++i];
    else if (arg === '--record') args.record = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.cooldownMinutes) || args.cooldownMinutes < 0) {
    throw new Error('--cooldown-minutes must be a non-negative integer');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/botland-daemon-watchdog.mjs [options]

Check BotLand daemon /health and restart the local user service when daemon
health is unhealthy or websocket_connected is false. This never sends BotLand
messages; it only touches local systemd and writes an optional local ledger.

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory
  --health-url <url>       Health endpoint. Default: http://127.0.0.1:3100/health
  --service <unit>         User systemd unit to restart. Default: botland-daemon.service
  --cooldown-minutes <n>   Minimum minutes between restarts. Default: 2
  --dry-run                Do not restart, only report intended action
  --confirm-restart <tok>  Required token for restart: RESTART_BOTLAND_DAEMON
  --record                 Write a local watchdog audit ledger
  --json                   Print JSON
  --help                   Show this help
`);
}

function stamp(prefix, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${prefix}_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function runCommand(command, args, timeoutMs = 10000) {
  const result = spawnSync(command, args, {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const stdout = result.stdout ? result.stdout.trim() : '';
  const stderr = result.stderr ? result.stderr.trim() : '';
  let stdoutJson = null;
  if (stdout) {
    try {
      stdoutJson = JSON.parse(stdout);
    } catch {
      stdoutJson = null;
    }
  }
  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout_json: stdoutJson,
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function parseHealth(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: null, healthy: false, websocket_connected: false, raw_keys: [] };
  }
  return {
    status: payload.status ?? null,
    healthy: payload.status === 'healthy' || payload.healthy === true || payload.ok === true,
    websocket_connected: payload.websocket_connected === true
      || payload.websocketConnected === true
      || payload.websocket?.connected === true
      || payload.bridge?.websocket_connected === true,
    raw_keys: Object.keys(payload).sort()
  };
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name)).sort().reverse();
}

function latestRestartLedger(agentDir) {
  const dir = path.join(agentDir, 'botland_daemon_watchdog');
  for (const file of listJsonFiles(dir)) {
    try {
      const ledger = JSON.parse(readFileSync(file, 'utf8'));
      if (ledger.restarted === true && ledger.generated_at) return ledger;
    } catch {
      // Artifact inventory reports malformed files separately.
    }
  }
  return null;
}

function writeLedger(agentDir, report) {
  const dir = path.join(agentDir, 'botland_daemon_watchdog');
  mkdirSync(dir, { recursive: true });
  const id = stamp('botland_daemon_watchdog', new Date(report.generated_at));
  const file = path.join(dir, `${id}.json`);
  writeFileSync(file, `${JSON.stringify({ ...report, ledger_id: id }, null, 2)}\n`);
  return path.relative(WORKSPACE, file);
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive BotLand daemon watchdog (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`health_ok: ${report.health.ok ? 'yes' : 'no'}`);
  lines.push(`daemon_healthy: ${report.daemon_health.healthy ? 'yes' : 'no'}`);
  lines.push(`websocket_connected: ${report.daemon_health.websocket_connected ? 'yes' : 'no'}`);
  lines.push(`restart_needed: ${report.restart_needed ? 'yes' : 'no'}`);
  lines.push(`restart_attempted: ${report.restart_attempted ? 'yes' : 'no'}`);
  lines.push(`restarted: ${report.restarted ? 'yes' : 'no'}`);
  lines.push(`reason: ${report.reason}`);
  if (report.restart_result) {
    lines.push(`restart_status: ${report.restart_result.status ?? 'n/a'}`);
  }
  if (report.ledger_path) lines.push(`ledger_path: ${report.ledger_path}`);
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const health = runCommand('curl', ['-fsS', '--max-time', '5', args.healthUrl], 8000);
  const daemonHealth = parseHealth(health.stdout_json);
  const restartNeeded = health.ok !== true || daemonHealth.healthy !== true || daemonHealth.websocket_connected !== true;
  const latestRestart = latestRestartLedger(agentDir);
  const cooldownUntil = latestRestart?.generated_at
    ? new Date(new Date(latestRestart.generated_at).getTime() + args.cooldownMinutes * 60 * 1000)
    : null;
  const cooldownActive = Boolean(cooldownUntil && cooldownUntil.getTime() > Date.now());
  const confirmOk = args.confirmRestart === 'RESTART_BOTLAND_DAEMON';
  const restartAttempted = restartNeeded && !cooldownActive && !args.dryRun && confirmOk;
  const restartResult = restartAttempted
    ? runCommand('systemctl', ['--user', 'restart', args.service], 20000)
    : null;
  const reason = !restartNeeded
    ? 'daemon_healthy'
    : cooldownActive
      ? 'restart_cooldown_active'
      : args.dryRun
        ? 'dry_run'
        : !confirmOk
          ? 'missing_restart_confirmation'
          : restartResult?.ok
            ? 'restarted_unhealthy_daemon'
            : 'restart_failed';

  const report = {
    generated_at: generatedAt,
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    local_only: true,
    external_write: false,
    botland_send: false,
    health_url: args.healthUrl,
    service: args.service,
    dry_run: args.dryRun,
    health: {
      command: health.command,
      ok: health.ok,
      status: health.status,
      stderr_preview: health.stderr_preview
    },
    daemon_health: daemonHealth,
    cooldown: {
      minutes: args.cooldownMinutes,
      active: cooldownActive,
      latest_restart_at: latestRestart?.generated_at ?? null,
      until: cooldownUntil?.toISOString() ?? null
    },
    restart_needed: restartNeeded,
    restart_attempted: restartAttempted,
    restarted: restartResult?.ok === true,
    reason,
    restart_result: restartResult
      ? {
          command: restartResult.command,
          ok: restartResult.ok,
          status: restartResult.status,
          stderr_preview: restartResult.stderr_preview
        }
      : null
  };
  if (args.record) report.ledger_path = writeLedger(agentDir, report);
  console.log(args.format === 'json' ? JSON.stringify(report, null, 2) : formatText(report));
  process.exit(restartNeeded && !args.dryRun && confirmOk && !cooldownActive && restartResult?.ok !== true ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
