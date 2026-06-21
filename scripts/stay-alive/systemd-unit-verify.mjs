#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

const EXPECTED_CYCLES = [
  { cycle: 'light', schedule: '*:0/30' },
  { cycle: 'social', schedule: '00,04,08,12,16,20:15' },
  { cycle: 'community', schedule: '02,06,10,14,18,22:25' },
  { cycle: 'reflect', schedule: '09,21:00' },
  { cycle: 'integrate', schedule: '23:30' },
  { cycle: 'event-wakeup', schedule: '*:*', service_kind: 'event_wakeup' },
  { cycle: 'botland-watchdog', schedule: '*:0/2', service_kind: 'botland_watchdog' },
  { cycle: 'local-governance', schedule: '01,07,13,19:40', service_kind: 'local_governance' },
  { cycle: 'service-recovery', schedule: '*:0/10', service_kind: 'service_recovery' }
];

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    workspace: WORKSPACE,
    unitDir: path.join(os.homedir(), '.config', 'systemd', 'user'),
    requireInstalled: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--workspace') args.workspace = path.resolve(argv[++i]);
    else if (arg === '--unit-dir') args.unitDir = path.resolve(argv[++i]);
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
  console.log(`Usage: node scripts/stay-alive/systemd-unit-verify.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --workspace <dir>        Expected Stay-Alive workspace. Default: current directory
  --unit-dir <dir>         systemd user unit directory. Default: ~/.config/systemd/user
  --require-installed      Treat missing units as hard errors instead of warnings.
  --json                   Print JSON instead of verification text.
  --help                   Show this help.

This command is read-only. It verifies local user systemd units for the
Stay-Alive timers and never reloads, starts, stops, enables, or disables systemd.
`);
}

function readUnit(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

function valuesForKey(content, key) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

function hasToken(value, token) {
  return value.split(/\s+/).includes(token);
}

function addIssue(issues, severity, code, message, unit = null) {
  issues.push({ severity, code, message, unit });
}

function verifyService(args, cycle) {
  const unitName = `stay-alive-${args.agent}-${cycle}.service`;
  const file = path.join(args.unitDir, unitName);
  const issues = [];
  const content = readUnit(file);
  const isEventWakeup = cycle === 'event-wakeup';
  const isWatchdog = cycle === 'botland-watchdog';
  const isLocalGovernance = cycle === 'local-governance';
  const isServiceRecovery = cycle === 'service-recovery';
  const isAutonomousSocial = ['light', 'social', 'community'].includes(cycle);

  if (!content) {
    addIssue(
      issues,
      args.requireInstalled ? 'error' : 'warning',
      'service_unit_missing',
      `Missing ${unitName}`,
      unitName
    );
    return { unit_name: unitName, path: file, exists: false, pass: args.requireInstalled === false, issues };
  }

  const workingDirectories = valuesForKey(content, 'WorkingDirectory');
  if (!workingDirectories.includes(args.workspace)) {
    addIssue(issues, 'error', 'service_working_directory_mismatch', `Expected WorkingDirectory=${args.workspace}`, unitName);
  }

  const pathEnvironments = valuesForKey(content, 'Environment').filter((value) => value.startsWith('PATH='));
  if (!pathEnvironments.some((value) => value.includes('.npm-global/bin'))) {
    addIssue(issues, 'error', 'service_path_missing_npm_global_bin', 'PATH environment must include .npm-global/bin for botland CLI discovery', unitName);
  }

  const preflightLines = valuesForKey(content, 'ExecStartPre');
  const preflight = preflightLines[0] ?? '';
  if (!isEventWakeup && !isWatchdog && !isLocalGovernance && !isServiceRecovery) {
    if (preflightLines.length !== 1) {
      addIssue(issues, 'error', 'service_preflight_gate_count_invalid', `Expected exactly one ExecStartPre, found ${preflightLines.length}`, unitName);
    }
    if (!preflight.includes(`${args.workspace}/scripts/stay-alive/preflight.mjs`)) {
      addIssue(issues, 'error', 'service_preflight_script_missing', 'ExecStartPre must run scripts/stay-alive/preflight.mjs from the expected workspace', unitName);
    }
    for (const token of ['--agent', args.agent, '--limit', '50', '--no-checkpoint', '--require-botland-live', '--allow-botland-polling-fallback']) {
      if (!hasToken(preflight, token)) {
        addIssue(issues, 'error', 'service_preflight_arg_missing', `ExecStartPre missing token: ${token}`, unitName);
      }
    }
  } else if (preflightLines.length > 0) {
    addIssue(issues, 'warning', 'service_preflight_gate_unexpected', 'This auxiliary service does not use ExecStartPre', unitName);
  }

  const execStartLines = valuesForKey(content, 'ExecStart');
  if (execStartLines.length !== 1) {
    addIssue(issues, 'error', 'service_exec_start_count_invalid', `Expected exactly one ExecStart, found ${execStartLines.length}`, unitName);
  }
  const execStart = execStartLines[0] ?? '';
  if (isEventWakeup) {
    if (!execStart.includes(`${args.workspace}/scripts/stay-alive/event-wakeup.mjs`)) {
      addIssue(issues, 'error', 'service_runner_script_missing', 'ExecStart must run scripts/stay-alive/event-wakeup.mjs from the expected workspace', unitName);
    }
  } else if (isWatchdog) {
    if (!execStart.includes(`${args.workspace}/scripts/stay-alive/botland-daemon-watchdog.mjs`)) {
      addIssue(issues, 'error', 'service_runner_script_missing', 'ExecStart must run scripts/stay-alive/botland-daemon-watchdog.mjs from the expected workspace', unitName);
    }
  } else if (isLocalGovernance) {
    if (!execStart.includes(`${args.workspace}/scripts/stay-alive/local-governance-cycle.mjs`)) {
      addIssue(issues, 'error', 'service_runner_script_missing', 'ExecStart must run scripts/stay-alive/local-governance-cycle.mjs from the expected workspace', unitName);
    }
  } else if (isServiceRecovery) {
    if (!execStart.includes(`${args.workspace}/scripts/stay-alive/service-failure-recovery.mjs`)) {
      addIssue(issues, 'error', 'service_runner_script_missing', 'ExecStart must run scripts/stay-alive/service-failure-recovery.mjs from the expected workspace', unitName);
    }
  } else if (isAutonomousSocial) {
    if (!execStart.includes(`${args.workspace}/scripts/stay-alive/autonomous-social-cycle.mjs`)) {
      addIssue(issues, 'error', 'service_runner_script_missing', 'ExecStart must run scripts/stay-alive/autonomous-social-cycle.mjs from the expected workspace for autonomous social cycles', unitName);
    }
  } else if (!execStart.includes(`${args.workspace}/scripts/stay-alive/run-cycle.mjs`)) {
    addIssue(issues, 'error', 'service_runner_script_missing', 'ExecStart must run scripts/stay-alive/run-cycle.mjs from the expected workspace', unitName);
  }
  const requiredTokens = isEventWakeup
    ? ['--agent', args.agent, '--run', '--record', '--require-botland-live', '--allow-botland-polling-fallback', '--json']
    : isWatchdog
      ? ['--agent', args.agent, '--record', '--confirm-restart', 'RESTART_BOTLAND_DAEMON', '--json']
      : isLocalGovernance
        ? ['--agent', args.agent, '--execute', '--confirm-governance', 'RUN_LOCAL_GOVERNANCE', '--json']
        : isServiceRecovery
          ? ['--agent', args.agent, '--execute', '--confirm-recovery', 'RECOVER_FAILED_SERVICES', '--json']
          : isAutonomousSocial
            ? ['--agent', args.agent, '--cycle', cycle, '--execute', '--confirm-send', 'SEND_DRAFT', '--json']
            : ['--agent', args.agent, '--cycle', cycle, '--dry-run', '--write-daemon-state'];
  for (const token of requiredTokens) {
    if (!hasToken(execStart, token)) {
      addIssue(issues, 'error', 'service_runner_arg_missing', `ExecStart missing token: ${token}`, unitName);
    }
  }

  return {
    unit_name: unitName,
    path: file,
    exists: true,
    pass: issues.filter((issue) => issue.severity === 'error').length === 0,
    issues,
    exec_start_pre: preflight || null,
    exec_start: execStart || null
  };
}

function verifyTimer(args, cycle, schedule) {
  const unitName = `stay-alive-${args.agent}-${cycle}.timer`;
  const file = path.join(args.unitDir, unitName);
  const issues = [];
  const content = readUnit(file);

  if (!content) {
    addIssue(
      issues,
      args.requireInstalled ? 'error' : 'warning',
      'timer_unit_missing',
      `Missing ${unitName}`,
      unitName
    );
    return { unit_name: unitName, path: file, exists: false, pass: args.requireInstalled === false, issues };
  }

  const calendars = valuesForKey(content, 'OnCalendar');
  if (!calendars.includes(schedule)) {
    addIssue(issues, 'error', 'timer_schedule_mismatch', `Expected OnCalendar=${schedule}`, unitName);
  }
  const persistent = valuesForKey(content, 'Persistent');
  if (!persistent.includes('true')) {
    addIssue(issues, 'error', 'timer_persistent_missing', 'Expected Persistent=true', unitName);
  }
  const randomized = valuesForKey(content, 'RandomizedDelaySec');
  if (randomized.length !== 1) {
    addIssue(issues, 'warning', 'timer_randomized_delay_missing', 'Expected one RandomizedDelaySec entry', unitName);
  }

  return {
    unit_name: unitName,
    path: file,
    exists: true,
    pass: issues.filter((issue) => issue.severity === 'error').length === 0,
    issues,
    on_calendar: calendars,
    persistent,
    randomized_delay_sec: randomized
  };
}

function buildReport(args) {
  const services = EXPECTED_CYCLES.map(({ cycle }) => verifyService(args, cycle));
  const timers = EXPECTED_CYCLES.map(({ cycle, schedule }) => verifyTimer(args, cycle, schedule));
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
    workspace: args.workspace,
    unit_dir: args.unitDir,
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
    preflight_gate_error_count: issues.filter((issue) => issue.code.startsWith('service_preflight')).length,
    runner_safety_error_count: issues.filter((issue) => issue.code.startsWith('service_runner')).length,
    timer_schedule_error_count: issues.filter((issue) => issue.code === 'timer_schedule_mismatch').length,
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

  lines.push(`Stay-Alive systemd unit verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`workspace: ${report.workspace}`);
  lines.push(`unit_dir: ${report.unit_dir}`);
  lines.push(`pass: ${boolLabel(report.pass)}`);
  lines.push(`level: ${report.level}`);
  lines.push(`errors: ${report.error_count}`);
  lines.push(`warnings: ${report.warning_count}`);
  lines.push(`existing_services: ${report.existing_service_count}/${report.service_count}`);
  lines.push(`existing_timers: ${report.existing_timer_count}/${report.timer_count}`);
  lines.push(`preflight_gate_errors: ${report.preflight_gate_error_count}`);
  lines.push(`runner_safety_errors: ${report.runner_safety_error_count}`);
  lines.push(`timer_schedule_errors: ${report.timer_schedule_error_count}`);
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('No unit drift found.');
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
