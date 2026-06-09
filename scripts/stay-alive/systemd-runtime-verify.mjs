#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  classifyFailedService,
  isFailedService,
  readServiceFailureLedgers
} from './service-failure-lib.mjs';

const WORKSPACE = process.cwd();

const EXPECTED_CYCLES = ['light', 'social', 'community', 'reflect', 'integrate', 'event-wakeup', 'botland-watchdog', 'local-governance', 'service-recovery'];

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    requireInstalled: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--require-installed') args.requireInstalled = true;
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
  console.log(`Usage: node scripts/stay-alive/systemd-runtime-verify.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --require-installed      Treat missing units as hard errors instead of warnings.
  --json                   Print JSON instead of verification text.
  --help                   Show this help.

This command is read-only. It uses systemctl --user show to verify the runtime
state of Stay-Alive services and timers. Failed service state is treated as a
recoverable runtime observation by default so one stale failed unit cannot
cascade through every later ExecStartPre gate. Timers, missing required units,
and systemctl read failures still fail closed. This command never reloads,
starts, stops, enables, or disables systemd units.
`);
}

function addIssue(issues, severity, code, message, unit = null) {
  issues.push({ severity, code, message, unit });
}

function runSystemctlShow(unitName) {
  const result = spawnSync('systemctl', [
    '--user',
    'show',
    unitName,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=UnitFileState',
    '--property=Result',
    '--property=ExecMainCode',
    '--property=ExecMainStatus',
    '--property=InvocationID',
    '--property=NTriggers',
    '--property=NextElapseUSecRealtime',
    '--property=LastTriggerUSec',
    '--no-pager'
  ], {
    encoding: 'utf8'
  });

  return {
    status: result.status ?? 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

function parseShow(stdout) {
  const properties = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    properties[key] = rest.join('=');
  }
  return properties;
}

function isMissing(properties, run) {
  return properties.LoadState === 'not-found'
    || /could not be found/i.test(run.stderr)
    || /not found/i.test(run.stderr);
}

function verifyService(args, cycle, ledgers) {
  const unitName = `stay-alive-${args.agent}-${cycle}.service`;
  const issues = [];
  const run = runSystemctlShow(unitName);
  const properties = parseShow(run.stdout);

  if (isMissing(properties, run)) {
    addIssue(
      issues,
      args.requireInstalled ? 'error' : 'warning',
      'service_runtime_unit_missing',
      `Missing runtime unit ${unitName}`,
      unitName
    );
    return { unit_name: unitName, type: 'service', exists: false, pass: args.requireInstalled === false, issues, properties, systemctl_status: run.status, systemctl_stderr: run.stderr || null };
  }

  if (run.status !== 0 && Object.keys(properties).length === 0) {
    addIssue(issues, 'error', 'systemctl_show_failed', run.stderr || `systemctl show exited ${run.status}`, unitName);
  }
  if (properties.LoadState && properties.LoadState !== 'loaded') {
    addIssue(issues, 'error', 'service_load_state_not_loaded', `LoadState=${properties.LoadState}`, unitName);
  }
  const provisionalUnit = { unit_name: unitName, type: 'service', exists: true, issues, properties, systemctl_status: run.status, systemctl_stderr: run.stderr || null };
  const failed = properties.ActiveState === 'failed' || properties.Result === 'failed';
  let failure = null;
  if (failed) {
    failure = classifyFailedService(provisionalUnit, ledgers);
    const issueCode = failure.inspected || failure.recovered
      ? 'service_failed_inspected'
      : 'service_failed_needs_recovery';
    addIssue(
      issues,
      'warning',
      issueCode,
      `ActiveState=${properties.ActiveState ?? 'unknown'} Result=${properties.Result ?? 'unknown'} inspection=${failure.inspection_action_id ?? 'none'} recovery=${failure.recovery_action_id ?? 'none'}`,
      unitName
    );
  }
  if (properties.UnitFileState && !['enabled', 'static', 'linked', 'linked-runtime'].includes(properties.UnitFileState)) {
    addIssue(issues, 'warning', 'service_unit_file_state_unexpected', `UnitFileState=${properties.UnitFileState}`, unitName);
  }

  return {
    unit_name: unitName,
    type: 'service',
    exists: true,
    pass: issues.filter((issue) => issue.severity === 'error').length === 0,
    issues,
    failure,
    properties,
    systemctl_status: run.status,
    systemctl_stderr: run.stderr || null
  };
}

function verifyTimer(args, cycle) {
  const unitName = `stay-alive-${args.agent}-${cycle}.timer`;
  const issues = [];
  const run = runSystemctlShow(unitName);
  const properties = parseShow(run.stdout);

  if (isMissing(properties, run)) {
    addIssue(
      issues,
      args.requireInstalled ? 'error' : 'warning',
      'timer_runtime_unit_missing',
      `Missing runtime unit ${unitName}`,
      unitName
    );
    return { unit_name: unitName, type: 'timer', exists: false, pass: args.requireInstalled === false, issues, properties, systemctl_status: run.status, systemctl_stderr: run.stderr || null };
  }

  if (run.status !== 0 && Object.keys(properties).length === 0) {
    addIssue(issues, 'error', 'systemctl_show_failed', run.stderr || `systemctl show exited ${run.status}`, unitName);
  }
  if (properties.LoadState && properties.LoadState !== 'loaded') {
    addIssue(issues, 'error', 'timer_load_state_not_loaded', `LoadState=${properties.LoadState}`, unitName);
  }
  if (properties.UnitFileState !== 'enabled') {
    addIssue(issues, 'error', 'timer_not_enabled', `UnitFileState=${properties.UnitFileState ?? 'unknown'}`, unitName);
  }
  if (properties.ActiveState !== 'active') {
    addIssue(issues, 'error', 'timer_not_active', `ActiveState=${properties.ActiveState ?? 'unknown'}`, unitName);
  }
  if (properties.Result === 'failed') {
    addIssue(issues, 'error', 'timer_failed', `Result=${properties.Result}`, unitName);
  }
  if (!properties.NextElapseUSecRealtime || properties.NextElapseUSecRealtime === '0') {
    addIssue(issues, 'warning', 'timer_next_elapse_missing', 'NextElapseUSecRealtime is empty or zero', unitName);
  }

  return {
    unit_name: unitName,
    type: 'timer',
    exists: true,
    pass: issues.filter((issue) => issue.severity === 'error').length === 0,
    issues,
    properties,
    systemctl_status: run.status,
    systemctl_stderr: run.stderr || null
  };
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const ledgers = readServiceFailureLedgers(agentDir);
  const services = EXPECTED_CYCLES.map((cycle) => verifyService(args, cycle, ledgers));
  const timers = EXPECTED_CYCLES.map((cycle) => verifyTimer(args, cycle));
  const issues = [...services, ...timers].flatMap((unit) => unit.issues);
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    require_installed: args.requireInstalled,
    pass: errorCount === 0,
    level: errorCount > 0 ? 'stop' : warningCount > 0 ? 'review' : 'ok',
    error_count: errorCount,
    warning_count: warningCount,
    service_count: services.length,
    timer_count: timers.length,
    existing_service_count: services.filter((service) => service.exists).length,
    existing_timer_count: timers.filter((timer) => timer.exists).length,
    missing_service_count: services.filter((service) => !service.exists).length,
    missing_timer_count: timers.filter((timer) => !timer.exists).length,
    failed_service_count: services.filter(isFailedService).length,
    uninspected_failed_service_count: services.filter((service) => service.issues.some((issue) => issue.code === 'service_failed_needs_recovery')).length,
    inspected_failed_service_count: services.filter((service) => service.issues.some((issue) => issue.code === 'service_failed_inspected')).length,
    recoverable_failed_service_count: services.filter((service) => service.issues.some((issue) => issue.code === 'service_failed_needs_recovery' || issue.code === 'service_failed_inspected')).length,
    service_failure_inspection_count: ledgers.inspections.length,
    service_failure_recovery_count: ledgers.recoveries.length,
    failed_timer_count: timers.filter((timer) => timer.issues.some((issue) => issue.code === 'timer_failed')).length,
    inactive_timer_count: timers.filter((timer) => timer.issues.some((issue) => issue.code === 'timer_not_active')).length,
    disabled_timer_count: timers.filter((timer) => timer.issues.some((issue) => issue.code === 'timer_not_enabled')).length,
    next_elapse_missing_count: timers.filter((timer) => timer.issues.some((issue) => issue.code === 'timer_next_elapse_missing')).length,
    issues,
    services,
    timers
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive systemd runtime verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`pass: ${boolLabel(report.pass)}`);
  lines.push(`level: ${report.level}`);
  lines.push(`errors: ${report.error_count}`);
  lines.push(`warnings: ${report.warning_count}`);
  lines.push(`existing_services: ${report.existing_service_count}/${report.service_count}`);
  lines.push(`existing_timers: ${report.existing_timer_count}/${report.timer_count}`);
  lines.push(`failed_services: ${report.failed_service_count}`);
  lines.push(`uninspected_failed_services: ${report.uninspected_failed_service_count}`);
  lines.push(`inspected_failed_services: ${report.inspected_failed_service_count}`);
  lines.push(`service_failure_inspections: ${report.service_failure_inspection_count}`);
  lines.push(`service_failure_recoveries: ${report.service_failure_recovery_count}`);
  lines.push(`failed_timers: ${report.failed_timer_count}`);
  lines.push(`inactive_timers: ${report.inactive_timer_count}`);
  lines.push(`disabled_timers: ${report.disabled_timer_count}`);
  lines.push(`next_elapse_missing: ${report.next_elapse_missing_count}`);
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('No runtime drift found.');
  } else {
    lines.push('Issues');
    for (const issue of report.issues) {
      lines.push(`- ${issue.severity}: ${issue.code}${issue.unit ? ` (${issue.unit})` : ''}: ${issue.message}`);
    }
  }
  lines.push('');
  lines.push('read_only: yes');
  lines.push('external_write: no');
  lines.push('botland_send: no');

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
