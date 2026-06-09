#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  classifyFailedService,
  isFailedService,
  readServiceFailureLedgers,
  WORKSPACE
} from './service-failure-lib.mjs';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    execute: false,
    confirmRecovery: null,
    limit: 8,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--confirm-recovery') args.confirmRecovery = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  if (args.execute && args.confirmRecovery !== 'RECOVER_FAILED_SERVICES') {
    throw new Error('Refusing recovery without --confirm-recovery RECOVER_FAILED_SERVICES');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/service-failure-recovery.mjs [options]

Options:
  --agent <id>                         Agent id. Default: badclaw
  --runtime-root <dir>                 Runtime agents directory.
  --limit <n>                          Max failed services to process. Default: 8
  --execute --confirm-recovery RECOVER_FAILED_SERVICES
                                       Inspect and reset recoverable failed services.
  --json                               Print JSON instead of text.
  --help                               Show this help.

This command is local-only. It inspects current failed Stay-Alive services,
writes inspection artifacts when missing, and may run systemctl --user
reset-failed for the inspected fingerprint. It never starts services and never
calls BotLand.
`);
}

function runJson(script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs, '--json'], {
    cwd: WORKSPACE,
    encoding: 'utf8'
  });
  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new Error(result.stderr.trim() || `${script} exited ${result.status ?? 0}`);
  }
  const parsed = JSON.parse(stdout);
  return { ok: result.status === 0, status: result.status ?? 0, stderr: result.stderr.trim(), parsed };
}

function currentRuntime(args) {
  return runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot
  ]).parsed;
}

function needsInspection(service) {
  return service.inspected !== true;
}

function buildPlan(args, runtime) {
  const ledgers = readServiceFailureLedgers(path.join(args.runtimeRoot, args.agent));
  return runtime.services
    .filter(isFailedService)
    .map((service) => classifyFailedService(service, ledgers))
    .slice(0, args.limit)
    .map((service) => ({
      unit_name: service.unit_name,
      failure_fingerprint: service.fingerprint,
      inspected: service.inspected,
      recovered: service.recovered,
      needs_inspection: needsInspection(service),
      planned_actions: [
        ...(needsInspection(service) ? ['inspect-service-failure'] : []),
        'reset-service-failure'
      ],
      inspection_action_id: service.inspection_action_id,
      recovery_action_id: service.recovery_action_id
    }));
}

function executePlan(args, plan) {
  const steps = [];
  for (const item of plan) {
    let inspection = null;
    if (item.needs_inspection) {
      inspection = runJson('scripts/stay-alive/inspect-service-failure.mjs', [
        '--agent',
        args.agent,
        '--runtime-root',
        args.runtimeRoot,
        '--unit',
        item.unit_name,
        '--failure-fingerprint',
        item.failure_fingerprint,
        '--inspected-by',
        'service-failure-recovery',
        '--note',
        'automatic local recovery inspected failed service before reset-failed'
      ]);
    }
    const reset = runJson('scripts/stay-alive/reset-service-failure.mjs', [
      '--agent',
      args.agent,
      '--runtime-root',
      args.runtimeRoot,
      '--unit',
      item.unit_name,
      '--failure-fingerprint',
      item.failure_fingerprint,
      '--confirm-reset',
      'RESET_FAILED_SERVICE'
    ]);
    steps.push({
      unit_name: item.unit_name,
      failure_fingerprint: item.failure_fingerprint,
      inspection: inspection?.parsed ?? null,
      reset: reset.parsed,
      ok: reset.ok && reset.parsed?.reset_ok === true
    });
  }
  return steps;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const before = currentRuntime(args);
  const plan = buildPlan(args, before);
  const steps = args.execute ? executePlan(args, plan) : [];
  const after = args.execute ? currentRuntime(args) : before;
  const ok = args.execute
    ? steps.every((step) => step.ok) && (after.uninspected_failed_service_count ?? 0) === 0
    : true;
  const report = {
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    dry_run: !args.execute,
    local_only: true,
    external_write: false,
    botland_send: false,
    pass: ok,
    level: ok ? ((after.failed_service_count ?? 0) > 0 ? 'review' : 'ok') : 'stop',
    before_failed_service_count: before.failed_service_count ?? 0,
    before_uninspected_failed_service_count: before.uninspected_failed_service_count ?? 0,
    planned_service_count: plan.length,
    executed_service_count: steps.length,
    after_failed_service_count: after.failed_service_count ?? 0,
    after_uninspected_failed_service_count: after.uninspected_failed_service_count ?? 0,
    plan,
    steps,
    result: {
      ok,
      status: args.execute ? 'service_recovery_executed' : 'service_recovery_preview',
      external_write: false
    }
  };
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`service_failure_recovery: ${report.result.status}`);
    console.log(`pass: ${report.pass ? 'yes' : 'no'}`);
    console.log(`before_failed_services: ${report.before_failed_service_count}`);
    console.log(`planned_services: ${report.planned_service_count}`);
    console.log(`executed_services: ${report.executed_service_count}`);
    console.log(`after_failed_services: ${report.after_failed_service_count}`);
    console.log(`after_uninspected_failed_services: ${report.after_uninspected_failed_service_count}`);
    console.log('external_write: no');
    console.log('botland_send: no');
  }
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
