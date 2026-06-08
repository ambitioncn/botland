#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  compactFailedService,
  isFailedService,
  latestMatchingLedger,
  readServiceFailureLedgers,
  WORKSPACE
} from './service-failure-lib.mjs';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    unit: null,
    failureFingerprint: null,
    confirmReset: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--unit') args.unit = argv[++i];
    else if (arg === '--failure-fingerprint') args.failureFingerprint = argv[++i];
    else if (arg === '--confirm-reset') args.confirmReset = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.unit) throw new Error('--unit is required');
  if (!args.failureFingerprint) throw new Error('--failure-fingerprint is required');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/reset-service-failure.mjs [options]

Options:
  --agent <id>                      Agent id. Default: badclaw
  --unit <unit.service>             Failed service unit to reset.
  --failure-fingerprint <sha256>    Failure fingerprint previously inspected.
  --runtime-root <dir>              Runtime agents directory.
  --confirm-reset RESET_FAILED_SERVICE
                                    Required to run systemctl --user reset-failed.
  --json                            Print JSON instead of text.
  --help                            Show this help.

This command performs one local systemd ack: systemctl --user reset-failed
for an inspected Stay-Alive service failure. It never starts services and never
calls BotLand.
`);
}

function runJson(script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs, '--json'], {
    cwd: WORKSPACE,
    encoding: 'utf8'
  });
  if (!result.stdout.trim() && result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${script} failed`);
  }
  return JSON.parse(result.stdout);
}

function actionId(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `service_failure_reset_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.confirmReset !== 'RESET_FAILED_SERVICE') {
    throw new Error('Refusing to reset failed service without --confirm-reset RESET_FAILED_SERVICE');
  }

  const agentDir = path.join(args.runtimeRoot, args.agent);
  const ledgers = readServiceFailureLedgers(agentDir);
  const inspection = latestMatchingLedger(ledgers.inspections, args.unit, args.failureFingerprint);
  if (!inspection) {
    throw new Error('Refusing reset: matching service failure inspection ledger not found');
  }

  const preRuntime = runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot
  ]);
  const target = preRuntime.services
    .filter(isFailedService)
    .map(compactFailedService)
    .find((service) => service.unit_name === args.unit);
  if (!target) throw new Error(`Refusing reset: current failed service not found: ${args.unit}`);
  if (target.fingerprint !== args.failureFingerprint) {
    throw new Error(`Refusing reset: current fingerprint ${target.fingerprint} does not match inspected ${args.failureFingerprint}`);
  }

  const reset = spawnSync('systemctl', ['--user', 'reset-failed', args.unit], {
    encoding: 'utf8'
  });
  const resetOk = reset.status === 0;
  const postRuntime = runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot
  ]);

  const now = new Date();
  const recovery = {
    action_id: actionId(now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: resetOk ? 'service_failure_reset' : 'service_failure_reset_failed',
    dry_run: false,
    local_only: true,
    external_write: false,
    botland_send: false,
    unit_name: args.unit,
    failure_fingerprint: args.failureFingerprint,
    inspected_action_id: inspection.action_id,
    inspected_action_path: inspection.ledger_path,
    pre_runtime_generated_at: preRuntime.generated_at,
    post_runtime_generated_at: postRuntime.generated_at,
    reset_command: 'systemctl --user reset-failed <unit>',
    reset_result: {
      ok: resetOk,
      status: reset.status ?? 0,
      stdout: reset.stdout.trim(),
      stderr: reset.stderr.trim()
    },
    result: {
      ok: resetOk,
      status: resetOk ? 'reset_failed_cleared' : 'reset_failed_command_failed',
      external_write: false
    }
  };

  const dir = path.join(agentDir, 'service_failure_recoveries');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${recovery.action_id}.json`);
  writeFileSync(file, `${JSON.stringify(recovery, null, 2)}\n`);

  const output = {
    action_id: recovery.action_id,
    action_path: path.relative(WORKSPACE, file),
    unit_name: args.unit,
    failure_fingerprint: args.failureFingerprint,
    reset_ok: resetOk,
    post_failed_service_count: postRuntime.failed_service_count,
    post_uninspected_failed_service_count: postRuntime.uninspected_failed_service_count,
    local_only: true,
    external_write: false,
    result: recovery.result
  };
  if (args.format === 'json') console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`service_failure_reset: ${output.action_id}`);
    console.log(`unit: ${output.unit_name}`);
    console.log(`reset_ok: ${output.reset_ok ? 'yes' : 'no'}`);
    console.log(`post_failed_services: ${output.post_failed_service_count}`);
    console.log(`action_path: ${output.action_path}`);
    console.log('external_write: no');
    console.log('botland_send: no');
  }
  process.exit(resetOk ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
