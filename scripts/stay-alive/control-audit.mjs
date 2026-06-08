#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

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
  console.log(`Usage: node scripts/stay-alive/control-audit.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It audits local control_state.json for operator pause,
resume, and expired-pause cleanup consistency. It never writes control state,
approves drafts, dismisses drafts, or sends BotLand messages.
`);
}

function defaultControlState(agentId) {
  return {
    schema_version: 1,
    agent_id: agentId,
    paused: false,
    paused_at: null,
    paused_by: null,
    pause_reason: null,
    pause_until: null,
    resumed_at: null,
    resumed_by: null,
    resume_reason: null,
    cleanup_at: null,
    cleanup_by: null,
    cleanup_reason: null,
    updated_at: null,
    history: []
  };
}

function controlPath(args) {
  return path.join(args.runtimeRoot, args.agent, 'control_state.json');
}

function normalizeControlState(state, nowMs = Date.now()) {
  const pauseUntilMs = state.pause_until ? new Date(state.pause_until).getTime() : null;
  const pauseExpired = state.paused === true
    && Number.isFinite(pauseUntilMs)
    && pauseUntilMs <= nowMs;

  return {
    ...state,
    paused_raw: state.paused === true,
    paused: state.paused === true && !pauseExpired,
    pause_until: state.pause_until ?? null,
    pause_expired: pauseExpired
  };
}

function readControlState(args) {
  const file = controlPath(args);
  if (!existsSync(file)) {
    return {
      exists: false,
      state: defaultControlState(args.agent)
    };
  }

  return {
    exists: true,
    state: {
      ...defaultControlState(args.agent),
      ...JSON.parse(readFileSync(file, 'utf8'))
    }
  };
}

function isValidDate(value) {
  if (!value) return true;
  return Number.isFinite(new Date(value).getTime());
}

function summarizeHistory(history) {
  const counts = {};
  for (const item of history) {
    const action = item?.action ?? 'unknown';
    counts[action] = (counts[action] ?? 0) + 1;
  }

  const latest = history.length > 0 ? history[history.length - 1] : null;
  return {
    count: history.length,
    counts,
    latest_action: latest
      ? {
          action: latest.action ?? null,
          created_at: latest.created_at ?? null,
          by: latest.by ?? null,
          reason: latest.reason ?? null
        }
      : null
  };
}

function auditControl(args) {
  const nowMs = Date.now();
  const file = controlPath(args);
  const read = readControlState(args);
  const rawState = read.state;
  const state = normalizeControlState(rawState, nowMs);
  const history = Array.isArray(rawState.history) ? rawState.history : [];
  const errors = [];
  const warnings = [];

  if (rawState.schema_version !== 1) {
    errors.push('unsupported_schema_version');
  }
  if (rawState.agent_id !== args.agent) {
    errors.push('agent_id_mismatch');
  }
  if (!Array.isArray(rawState.history)) {
    errors.push('history_not_array');
  }
  if (!isValidDate(rawState.paused_at)) {
    errors.push('invalid_paused_at');
  }
  if (!isValidDate(rawState.pause_until)) {
    errors.push('invalid_pause_until');
  }
  if (!isValidDate(rawState.resumed_at)) {
    errors.push('invalid_resumed_at');
  }
  if (!isValidDate(rawState.cleanup_at)) {
    errors.push('invalid_cleanup_at');
  }
  if (rawState.paused === true && !rawState.paused_at) {
    errors.push('paused_without_paused_at');
  }
  if (state.paused === true && rawState.pause_until) {
    warnings.push('active_timed_pause');
  }
  if (state.paused === true && !rawState.pause_until) {
    warnings.push('active_untimed_pause');
  }
  if (state.pause_expired === true) {
    warnings.push('expired_timed_pause_needs_cleanup');
  }
  if (!read.exists) {
    warnings.push('control_state_missing_using_default');
  }

  for (const item of history) {
    if (!item || typeof item !== 'object') {
      errors.push('invalid_history_item');
      continue;
    }
    if (!item.action) errors.push('history_item_missing_action');
    if (!isValidDate(item.created_at)) errors.push('history_item_invalid_created_at');
  }

  const pass = errors.length === 0;
  const level = !pass
    ? 'stop'
    : state.paused
      ? 'stop'
      : state.pause_expired
        ? 'cleanup'
        : warnings.length > 0
          ? 'review'
          : 'ok';

  return {
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date(nowMs).toISOString(),
    agent_id: args.agent,
    control_path: path.relative(WORKSPACE, file),
    control_state_exists: read.exists,
    pass,
    level,
    errors,
    warnings,
    control_state: {
      paused: state.paused === true,
      paused_raw: state.paused_raw === true,
      paused_at: state.paused_at ?? null,
      paused_by: state.paused_by ?? null,
      pause_reason: state.pause_reason ?? null,
      pause_until: state.pause_until ?? null,
      pause_expired: state.pause_expired === true,
      resumed_at: state.resumed_at ?? null,
      cleanup_at: state.cleanup_at ?? null,
      updated_at: state.updated_at ?? null
    },
    history: summarizeHistory(history),
    suggested_next_command: state.pause_expired
      ? `node scripts/stay-alive/control-state.mjs cleanup-expired --agent ${args.agent} --reason "expired pause cleanup"`
      : state.paused
        ? `node scripts/stay-alive/control-state.mjs status --agent ${args.agent}`
        : `node scripts/stay-alive/control-state.mjs status --agent ${args.agent}`
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive control audit (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`control_path: ${report.control_path}`);
  lines.push(`control_state_exists: ${boolLabel(report.control_state_exists)}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${boolLabel(report.pass)}`);
  lines.push(`- errors: ${report.errors.length > 0 ? report.errors.join(', ') : 'none'}`);
  lines.push(`- warnings: ${report.warnings.length > 0 ? report.warnings.join(', ') : 'none'}`);
  lines.push('');
  lines.push('Control');
  lines.push(`- paused: ${boolLabel(report.control_state.paused)}`);
  lines.push(`- paused_raw: ${boolLabel(report.control_state.paused_raw)}`);
  lines.push(`- paused_at: ${report.control_state.paused_at ?? 'none'}`);
  lines.push(`- pause_reason: ${report.control_state.pause_reason ?? 'none'}`);
  lines.push(`- pause_until: ${report.control_state.pause_until ?? 'none'}`);
  lines.push(`- pause_expired: ${boolLabel(report.control_state.pause_expired)}`);
  lines.push(`- cleanup_at: ${report.control_state.cleanup_at ?? 'none'}`);
  lines.push('');
  lines.push('History');
  lines.push(`- count: ${report.history.count}`);
  lines.push(`- latest_action: ${report.history.latest_action?.action ?? 'none'}`);
  lines.push(`- latest_created_at: ${report.history.latest_action?.created_at ?? 'none'}`);
  lines.push('');
  lines.push(`suggested_next_command: ${report.suggested_next_command}`);
  lines.push('external_write: no');
  lines.push('botland_send: no');

  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = auditControl(args);
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
