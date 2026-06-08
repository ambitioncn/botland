#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    command: null,
    reason: null,
    until: null,
    minutes: null,
    by: 'operator',
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (['status', 'pause', 'resume', 'cleanup-expired'].includes(arg) && !args.command) args.command = arg;
    else if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--reason') args.reason = argv[++i];
    else if (arg === '--until') args.until = argv[++i];
    else if (arg === '--minutes') args.minutes = Number.parseFloat(argv[++i]);
    else if (arg === '--by') args.by = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.command) args.command = 'status';
  if (args.until && args.minutes !== null) {
    throw new Error('Use only one of --until or --minutes');
  }
  if (args.minutes !== null && (!Number.isFinite(args.minutes) || args.minutes <= 0)) {
    throw new Error('--minutes must be a positive number');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/control-state.mjs <status|pause|resume|cleanup-expired> [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --reason <text>       Reason stored when pausing, resuming, or cleaning up.
  --until <iso-time>     Pause until this ISO timestamp, then preflight auto-passes.
  --minutes <n>          Pause for n minutes, then preflight auto-passes.
  --by <label>          Operator label stored in control state. Default: operator
  --json                Print JSON instead of text.
  --help                Show this help.

This command writes only local control_state.json for operator gating. It never
approves drafts, dismisses drafts, or sends BotLand messages.

cleanup-expired only writes when a timed pause has already expired. Active
pauses and untimed pauses are refused.
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

function parsePauseUntil(args, nowMs) {
  if (args.command !== 'pause') return null;
  if (args.minutes !== null) return new Date(nowMs + Math.round(args.minutes * 60 * 1000)).toISOString();
  if (!args.until) return null;

  const parsed = new Date(args.until);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('--until must be a valid date/time string');
  }
  if (parsed.getTime() <= nowMs) {
    throw new Error('--until must be in the future');
  }
  return parsed.toISOString();
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
    pause_expired: pauseExpired,
    pause_until: state.pause_until ?? null
  };
}

function controlPath(args) {
  return path.join(args.runtimeRoot, args.agent, 'control_state.json');
}

function readControlState(args) {
  const file = controlPath(args);
  if (!existsSync(file)) return defaultControlState(args.agent);
  return {
    ...defaultControlState(args.agent),
    ...JSON.parse(readFileSync(file, 'utf8'))
  };
}

function writeControlState(args, state) {
  const file = controlPath(args);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

function updateControlState(args) {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const previous = readControlState(args);
  const previousNormalized = normalizeControlState(previous, nowMs);
  const pauseUntil = parsePauseUntil(args, nowMs);
  const next = {
    ...previous,
    schema_version: 1,
    agent_id: args.agent,
    updated_at: now,
    history: Array.isArray(previous.history) ? previous.history.slice(-49) : []
  };

  if (args.command === 'pause') {
    next.paused = true;
    next.paused_at = now;
    next.paused_by = args.by;
    next.pause_reason = args.reason;
    next.pause_until = pauseUntil;
    next.history.push({
      action: 'pause',
      created_at: now,
      by: args.by,
      reason: args.reason,
      until: pauseUntil
    });
  } else if (args.command === 'resume') {
    next.paused = false;
    next.pause_until = null;
    next.resumed_at = now;
    next.resumed_by = args.by;
    next.resume_reason = args.reason;
    next.history.push({
      action: 'resume',
      created_at: now,
      by: args.by,
      reason: args.reason
    });
  } else if (args.command === 'cleanup-expired') {
    if (previous.paused !== true || previous.pause_until === null) {
      throw new Error('No timed pause to clean up');
    }
    if (previousNormalized.pause_expired !== true) {
      throw new Error('Timed pause has not expired; refusing to clean up an active pause');
    }

    next.paused = false;
    next.pause_until = null;
    next.cleanup_at = now;
    next.cleanup_by = args.by;
    next.cleanup_reason = args.reason ?? 'expired timed pause cleanup';
    next.history.push({
      action: 'cleanup_expired',
      created_at: now,
      by: args.by,
      reason: next.cleanup_reason,
      expired_pause_until: previous.pause_until
    });
  }

  const pathWritten = args.command === 'status' ? null : writeControlState(args, next);
  const normalized = normalizeControlState(next, nowMs);

  return {
    local_only: true,
    external_write: false,
    botland_send: false,
    command: args.command,
    control_path: path.relative(WORKSPACE, controlPath(args)),
    path_written: pathWritten ? path.relative(WORKSPACE, pathWritten) : null,
    control_state: normalized
  };
}

function formatText(result) {
  const state = result.control_state;
  const lines = [];

  lines.push(`Stay-Alive control state (${state.agent_id})`);
  lines.push(`command: ${result.command}`);
  lines.push(`paused: ${state.paused ? 'yes' : 'no'}`);
  lines.push(`paused_raw: ${state.paused_raw ? 'yes' : 'no'}`);
  lines.push(`paused_at: ${state.paused_at ?? 'none'}`);
  lines.push(`paused_by: ${state.paused_by ?? 'none'}`);
  lines.push(`pause_reason: ${state.pause_reason ?? 'none'}`);
  lines.push(`pause_until: ${state.pause_until ?? 'none'}`);
  lines.push(`pause_expired: ${state.pause_expired ? 'yes' : 'no'}`);
  lines.push(`resumed_at: ${state.resumed_at ?? 'none'}`);
  lines.push(`cleanup_at: ${state.cleanup_at ?? 'none'}`);
  lines.push(`control_path: ${result.control_path}`);
  lines.push(`path_written: ${result.path_written ?? 'no'}`);
  lines.push('external_write: no');
  lines.push('botland_send: no');

  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = updateControlState(args);
  if (args.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(formatText(result));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
