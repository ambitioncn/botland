#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { compactFailedService, isFailedService, WORKSPACE } from './service-failure-lib.mjs';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    unit: null,
    failureFingerprint: null,
    inspectedBy: 'operator',
    note: 'systemd failed service inspected',
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--unit') args.unit = argv[++i];
    else if (arg === '--failure-fingerprint') args.failureFingerprint = argv[++i];
    else if (arg === '--inspected-by') args.inspectedBy = argv[++i];
    else if (arg === '--note') args.note = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/inspect-service-failure.mjs [options]

Options:
  --agent <id>                      Agent id. Default: badclaw
  --unit <unit.service>             Failed service unit. Default: newest failed service.
  --failure-fingerprint <sha256>    Expected failure fingerprint.
  --runtime-root <dir>              Runtime agents directory.
  --inspected-by <name>             Local inspector label. Default: operator
  --note <text>                     Inspection note.
  --json                            Print JSON instead of text.
  --help                            Show this help.

This command writes a local-only inspection artifact for a current failed
Stay-Alive systemd service. It never resets units and never calls BotLand.
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
  return `service_failure_inspect_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot
  ]);
  const failedServices = runtime.services.filter(isFailedService).map(compactFailedService);
  const target = args.unit
    ? failedServices.find((service) => service.unit_name === args.unit)
    : failedServices[0] ?? null;
  if (!target) throw new Error(args.unit ? `Failed service not found: ${args.unit}` : 'No failed service found');
  if (args.failureFingerprint && args.failureFingerprint !== target.fingerprint) {
    throw new Error(`Failure fingerprint mismatch: expected=${args.failureFingerprint}, current=${target.fingerprint}`);
  }

  const now = new Date();
  const inspection = {
    action_id: actionId(now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: 'service_failure_inspected',
    dry_run: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    unit_name: target.unit_name,
    failure_fingerprint: target.fingerprint,
    inspected_at: now.toISOString(),
    inspected_by: args.inspectedBy,
    inspection_note: args.note,
    failure: target,
    systemd_runtime_generated_at: runtime.generated_at,
    result: {
      ok: true,
      status: 'inspected',
      external_write: false
    }
  };

  const dir = path.join(args.runtimeRoot, args.agent, 'service_failure_inspections');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${inspection.action_id}.json`);
  writeFileSync(file, `${JSON.stringify(inspection, null, 2)}\n`);

  const output = {
    action_id: inspection.action_id,
    action_path: path.relative(WORKSPACE, file),
    unit_name: target.unit_name,
    failure_fingerprint: target.fingerprint,
    local_only: true,
    external_write: false,
    result: inspection.result
  };
  if (args.format === 'json') console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`service_failure_inspected: ${output.action_id}`);
    console.log(`unit: ${output.unit_name}`);
    console.log(`failure_fingerprint: ${output.failure_fingerprint}`);
    console.log(`action_path: ${output.action_path}`);
    console.log('external_write: no');
    console.log('botland_send: no');
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
