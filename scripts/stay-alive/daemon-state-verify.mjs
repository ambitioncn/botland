#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const KNOWN_CYCLES = new Set(['light', 'social', 'community', 'reflect', 'integrate']);

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
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
  console.log(`Usage: node scripts/stay-alive/daemon-state-verify.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --json                Print JSON instead of verification text.
  --help                Show this help.

This command is read-only. It verifies daemon_state.json schema, timestamps,
event tracking shape, and references to local run artifacts. It never approves
drafts, dismisses drafts, or sends BotLand messages.
`);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listRunFiles(runsDir) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse();
}

function addIssue(issues, level, code, message) {
  issues.push({ level, code, message });
}

function verifyTimestampMap(issues, map, fieldName) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    addIssue(issues, 'error', `${fieldName}_invalid`, `${fieldName} must be an object`);
    return;
  }

  for (const [cycle, timestamp] of Object.entries(map)) {
    if (!KNOWN_CYCLES.has(cycle)) {
      addIssue(issues, 'warning', `${fieldName}_unknown_cycle`, `${fieldName} contains unknown cycle ${cycle}`);
    }
    if (!isIsoDate(timestamp)) {
      addIssue(issues, 'error', `${fieldName}_timestamp_invalid`, `${fieldName}.${cycle} must be an ISO timestamp`);
    }
  }
}

function verifyCooldowns(issues, cooldowns) {
  if (!cooldowns || typeof cooldowns !== 'object' || Array.isArray(cooldowns)) {
    addIssue(issues, 'error', 'cooldowns_invalid', 'cooldowns must be an object');
    return;
  }

  for (const [name, value] of Object.entries(cooldowns)) {
    if (value !== null && !isIsoDate(value)) {
      addIssue(issues, 'error', 'cooldown_timestamp_invalid', `cooldowns.${name} must be null or an ISO timestamp`);
    }
  }
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const daemonStatePath = path.join(agentDir, 'daemon_state.json');
  const runsDir = path.join(agentDir, 'runs');
  const issues = [];

  if (!existsSync(daemonStatePath)) {
    addIssue(issues, 'warning', 'daemon_state_missing_using_default', `No daemon_state.json found: ${daemonStatePath}`);
    return finishReport(args, daemonStatePath, runsDir, null, [], issues);
  }

  let daemonState = null;
  try {
    daemonState = readJson(daemonStatePath);
  } catch (error) {
    addIssue(issues, 'error', 'daemon_state_json_invalid', error instanceof Error ? error.message : String(error));
    return finishReport(args, daemonStatePath, runsDir, null, [], issues);
  }

  const runFiles = listRunFiles(runsDir);
  const runIds = new Set(runFiles.map((file) => path.basename(file, '.json')));
  const latestRunId = runFiles[0] ? path.basename(runFiles[0], '.json') : null;

  if (daemonState.schema_version !== 1) {
    addIssue(issues, 'error', 'schema_version_invalid', 'daemon_state.schema_version must equal 1');
  }
  if (daemonState.agent_id !== args.agent) {
    addIssue(issues, 'error', 'agent_id_mismatch', `daemon_state.agent_id must equal ${args.agent}`);
  }
  if (!isIsoDate(daemonState.updated_at)) {
    addIssue(issues, 'error', 'updated_at_invalid', 'daemon_state.updated_at must be an ISO timestamp');
  }
  if (!Number.isInteger(daemonState.run_count) || daemonState.run_count < 0) {
    addIssue(issues, 'error', 'run_count_invalid', 'daemon_state.run_count must be a non-negative integer');
  }
  if (daemonState.last_run_id !== null && typeof daemonState.last_run_id !== 'string') {
    addIssue(issues, 'error', 'last_run_id_invalid', 'daemon_state.last_run_id must be null or a string');
  }
  if (typeof daemonState.last_run_id === 'string' && !runIds.has(daemonState.last_run_id)) {
    addIssue(issues, 'error', 'last_run_missing', `last_run_id does not exist in runs/: ${daemonState.last_run_id}`);
  }
  if (typeof daemonState.last_run_id === 'string' && latestRunId && daemonState.last_run_id !== latestRunId) {
    addIssue(issues, 'warning', 'last_run_not_latest', `last_run_id ${daemonState.last_run_id} is not latest run ${latestRunId}`);
  }

  verifyTimestampMap(issues, daemonState.last_run_at_by_cycle, 'last_run_at_by_cycle');
  verifyTimestampMap(issues, daemonState.next_check_after_by_cycle, 'next_check_after_by_cycle');
  verifyCooldowns(issues, daemonState.cooldowns);

  if (!Array.isArray(daemonState.processed_event_ids)) {
    addIssue(issues, 'error', 'processed_event_ids_invalid', 'processed_event_ids must be an array');
  } else {
    const seen = new Set();
    for (const eventId of daemonState.processed_event_ids) {
      if (typeof eventId !== 'string' || eventId.length === 0) {
        addIssue(issues, 'error', 'processed_event_id_invalid', 'processed_event_ids must contain non-empty strings');
      } else if (seen.has(eventId)) {
        addIssue(issues, 'error', 'processed_event_id_duplicate', `Duplicate processed event id: ${eventId}`);
      }
      seen.add(eventId);
    }
    if (daemonState.processed_event_ids.length > 5000) {
      addIssue(issues, 'warning', 'processed_event_ids_large', 'processed_event_ids is large; consider pruning old ids');
    }
  }

  if (daemonState.last_seen_event_id !== null && typeof daemonState.last_seen_event_id !== 'string') {
    addIssue(issues, 'error', 'last_seen_event_id_invalid', 'last_seen_event_id must be null or a string');
  }

  return finishReport(args, daemonStatePath, runsDir, daemonState, runFiles, issues);
}

function finishReport(args, daemonStatePath, runsDir, daemonState, runFiles, issues) {
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    daemon_state_path: path.relative(WORKSPACE, daemonStatePath),
    runs_dir: path.relative(WORKSPACE, runsDir),
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    missing: daemonState === null,
    last_run_missing_count: issues.filter((issue) => issue.code === 'last_run_missing').length,
    last_run_not_latest_count: issues.filter((issue) => issue.code === 'last_run_not_latest').length,
    processed_event_duplicate_count: issues.filter((issue) => issue.code === 'processed_event_id_duplicate').length,
    run_reference_error_count: issues.filter((issue) => issue.code === 'last_run_missing').length,
    errors,
    warnings,
    daemon_state: daemonState
      ? {
          schema_version: daemonState.schema_version ?? null,
          agent_id: daemonState.agent_id ?? null,
          updated_at: daemonState.updated_at ?? null,
          run_count: daemonState.run_count ?? null,
          last_run_id: daemonState.last_run_id ?? null,
          latest_run_id: runFiles[0] ? path.basename(runFiles[0], '.json') : null,
          processed_event_count: Array.isArray(daemonState.processed_event_ids)
            ? daemonState.processed_event_ids.length
            : null,
          last_seen_event_id: daemonState.last_seen_event_id ?? null
        }
      : null
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const state = report.daemon_state ?? {};
  const lines = [];

  lines.push(`Stay-Alive daemon state verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${boolLabel(report.read_only)}`);
  lines.push(`daemon_state_path: ${report.daemon_state_path}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${boolLabel(report.pass)}`);
  lines.push(`- errors: ${report.error_count}`);
  lines.push(`- warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('Daemon State');
  lines.push(`- missing: ${boolLabel(report.missing)}`);
  lines.push(`- run_count: ${state.run_count ?? 'n/a'}`);
  lines.push(`- last_run_id: ${state.last_run_id ?? 'none'}`);
  lines.push(`- latest_run_id: ${state.latest_run_id ?? 'none'}`);
  lines.push(`- last_run_missing_count: ${report.last_run_missing_count}`);
  lines.push(`- last_run_not_latest_count: ${report.last_run_not_latest_count}`);
  lines.push(`- processed_event_count: ${state.processed_event_count ?? 'n/a'}`);
  lines.push(`- processed_event_duplicate_count: ${report.processed_event_duplicate_count}`);
  lines.push(`- last_seen_event_id: ${state.last_seen_event_id ?? 'none'}`);

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
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
