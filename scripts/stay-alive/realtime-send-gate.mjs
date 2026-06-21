#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    actionLimit: 10000,
    requireBotlandLive: true,
    allowBotlandPollingFallback: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--action-limit') args.actionLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--require-botland-live') args.requireBotlandLive = true;
    else if (arg === '--no-require-botland-live') args.requireBotlandLive = false;
    else if (arg === '--allow-botland-polling-fallback') args.allowBotlandPollingFallback = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.actionLimit) || args.actionLimit < 1) {
    throw new Error('--action-limit must be a positive integer');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/realtime-send-gate.mjs [options]

Options:
  --agent <id>              Agent id. Default: badclaw
  --runtime-root <dir>      Runtime agents directory.
  --action-limit <n>        Action audit window. Default: 10000
  --require-botland-live    Require BotLand live bridge. Default.
  --no-require-botland-live Skip live bridge hard gate.
  --allow-botland-polling-fallback
                            Let durable events polling degrade daemon WS drift to review.
  --json                    Print JSON instead of text.
  --help                    Show this help.

This is the realtime external-send gate. It checks only hazards that should
block the next BotLand send: BotLand identity mismatch or inability to verify
identity. Internal-leakage checks are enforced by the draft/action policy layer.
It intentionally leaves pause state, rate limits, uninspected sends, daemon
health, historical proposals, checkpoints, runtime inventory, old attention
runs, and service bookkeeping to maintenance paths.
`);
}

function runtimeRootArgs(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function runJson(script, scriptArgs, options = {}) {
  const result = spawnSync(process.execPath, [
    script,
    ...scriptArgs,
    ...(options.addJsonFlag ? ['--json'] : [])
  ], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60000,
    maxBuffer: 8 * 1024 * 1024
  });

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Could not parse JSON from ${script}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    status: result.status ?? 0,
    ok: result.status === 0 && !result.error,
    error: result.error ? result.error.message : null,
    stderr,
    parsed
  };
}

function addFinding(findings, code) {
  if (!findings.includes(code)) findings.push(code);
}

function buildReport(args) {
  const commonArgs = ['--agent', args.agent, ...runtimeRootArgs(args)];
  const bridgeRun = runJson(
    'scripts/stay-alive/botland-bridge-verify.mjs',
    [
      '--agent',
      args.agent,
      ...runtimeRootArgs(args),
      ...(args.allowBotlandPollingFallback ? ['--allow-polling-fallback'] : [])
    ],
    { addJsonFlag: true, timeoutMs: 90000 }
  );

  const bridge = bridgeRun.parsed ?? {};
  const safetyFindings = [];
  const warnings = [];

  const expectedCitizenId = bridge.expected_citizen_id ?? null;
  const whoamiCitizenId = bridge.whoami?.citizen_id ?? bridge.whoami_citizen_id ?? null;
  if (!expectedCitizenId || !whoamiCitizenId) {
    addFinding(safetyFindings, 'botland_identity_unverified');
  }
  if ((bridge.identity_mismatch_count ?? 0) > 0 || (expectedCitizenId && whoamiCitizenId && expectedCitizenId !== whoamiCitizenId)) {
    addFinding(safetyFindings, 'botland_bridge_identity_mismatch_detected');
  }

  if ((bridge.warning_count ?? 0) > 0) {
    warnings.push(`botland_bridge_warning_count:${bridge.warning_count}`);
  }

  const pass = safetyFindings.length === 0;
  return {
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    mode: 'realtime_send',
    require_botland_live: args.requireBotlandLive,
    allow_botland_polling_fallback: args.allowBotlandPollingFallback,
    pass,
    ok: pass,
    level: pass ? (warnings.length > 0 ? 'review' : 'ok') : 'stop',
    safety_findings: safetyFindings,
    warnings,
    summary: pass
      ? 'Realtime send gate passed. Only BotLand identity matching is enforced here.'
      : 'Realtime send gate could not verify the BotLand identity match.',
    checks: {
      botland_bridge_verification: {
        pass: bridge.pass === true,
        level: bridge.level ?? null,
        error_count: bridge.error_count ?? 0,
        warning_count: bridge.warning_count ?? 0,
        expected_citizen_id: bridge.expected_citizen_id ?? null,
        whoami_citizen_id: bridge.whoami?.citizen_id ?? bridge.whoami_citizen_id ?? null,
        daemon_healthy: bridge.daemon_health?.healthy ?? bridge.daemon_healthy ?? null,
        websocket_connected: bridge.daemon_health?.websocket_connected ?? bridge.websocket_connected ?? null
      }
    }
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive realtime send gate (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`pass: ${report.pass ? 'yes' : 'no'}`);
  lines.push(`level: ${report.level}`);
  lines.push(`safety_findings: ${report.safety_findings.length > 0 ? report.safety_findings.join(', ') : 'none'}`);
  if (report.warnings.length > 0) lines.push(`warnings: ${report.warnings.join(', ')}`);
  lines.push(report.summary);
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
