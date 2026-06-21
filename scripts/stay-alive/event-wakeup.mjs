#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BOTLAND_INTENTS } from './botland-adapter/contract.mjs';
import { runBotlandIntent } from './botland-adapter/cli-driver.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const DEFAULT_COMMAND_PATHS = [
  path.join(process.env.HOME ?? '', '.npm-global', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
].filter(Boolean);

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    eventLimit: 20,
    cooldownMinutes: 10,
    run: false,
    record: false,
    noBotland: false,
    requireBotlandLive: false,
    allowBotlandPollingFallback: false,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--event-limit') args.eventLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--cooldown-minutes') args.cooldownMinutes = Number.parseInt(argv[++i], 10);
    else if (arg === '--run') args.run = true;
    else if (arg === '--record') args.record = true;
    else if (arg === '--no-botland') args.noBotland = true;
    else if (arg === '--require-botland-live') args.requireBotlandLive = true;
    else if (arg === '--allow-botland-polling-fallback') args.allowBotlandPollingFallback = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.eventLimit) || args.eventLimit < 1) throw new Error('--event-limit must be a positive integer');
  if (!Number.isInteger(args.cooldownMinutes) || args.cooldownMinutes < 0) throw new Error('--cooldown-minutes must be a non-negative integer');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/event-wakeup.mjs [options]

Check BotLand durable events, compare them with daemon_state.processed_event_ids,
and optionally trigger one tool-supervised light cycle when unseen events exist.
This command never bypasses the send gate; with --run it delegates to
autonomous-social-cycle.mjs, which runs run-cycle -> apply-action ->
inspect-send -> action-outcome and only marks a source event processed after a
successful inspected send.

Options:
  --agent <id>              Agent id. Default: badclaw
  --runtime-root <dir>      Runtime agents directory
  --event-limit <n>         Max events to read. Default: 20
  --cooldown-minutes <n>    Min minutes between triggers. Default: 10
  --run                     Trigger one tool-supervised light cycle if unseen events exist
  --record                  Write a local event_wakeup audit ledger
  --no-botland              Skip live BotLand event read, useful for local checks
  --require-botland-live    Require live BotLand bridge in preflight
  --allow-botland-polling-fallback
                            Let durable events polling degrade daemon WS health drift to review
  --json                    Print JSON
  --help                    Show this help
`);
}

function commandEnv() {
  const existingPath = process.env.PATH ?? '';
  const pathParts = existingPath.split(':').filter(Boolean);
  return {
    ...process.env,
    PATH: [...DEFAULT_COMMAND_PATHS, ...pathParts].filter((item, index, arr) => arr.indexOf(item) === index).join(':')
  };
}

function runCommand(command, args, timeoutMs = 20000) {
  const result = spawnSync(command, args, {
    cwd: WORKSPACE,
    env: commandEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
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
    error: result.error ? result.error.message : null,
    stdout_json: stdoutJson,
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function stamp(prefix, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${prefix}_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name)).sort().reverse();
}

function latestWakeupLedger(agentDir) {
  const dir = path.join(agentDir, 'event_wakeup');
  for (const file of listJsonFiles(dir)) {
    try {
      const ledger = readJson(file);
      if (ledger.triggered === true && ledger.generated_at) return ledger;
    } catch {
      // Ignore malformed files; artifact-inventory reports them separately.
    }
  }
  return null;
}

function writeWakeupLedger(agentDir, report) {
  const dir = path.join(agentDir, 'event_wakeup');
  mkdirSync(dir, { recursive: true });
  const id = stamp('event_wakeup', new Date(report.generated_at));
  const file = path.join(dir, `${id}.json`);
  writeFileSync(file, `${JSON.stringify({ ...report, ledger_id: id }, null, 2)}\n`);
  return path.relative(WORKSPACE, file);
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function getEventId(event) {
  return event.id ?? event.event_id ?? event.event_key ?? event.payload?.event_id ?? event.payload?.message?.id ?? null;
}

function getEventTimestamp(event) {
  return event.created_at ?? event.timestamp ?? event.payload?.created_at ?? event.payload?.message?.timestamp ?? '';
}

function extractEvents(check) {
  if (Array.isArray(check?.adapter?.normalized)) return check.adapter.normalized;
  const payload = check?.stdout_json;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['events', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function latestSeenEventId(events) {
  const ordered = events
    .map((event, index) => ({ id: getEventId(event), timestamp: getEventTimestamp(event), index }))
    .filter((event) => event.id)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.index - b.index);
  return ordered.at(-1)?.id ?? null;
}

function botlandEventBaselineReady(daemonState) {
  if (typeof daemonState.last_seen_botland_event_id === 'string' && daemonState.last_seen_botland_event_id) return true;
  return Array.isArray(daemonState.processed_event_ids)
    && daemonState.processed_event_ids.some((id) => typeof id === 'string' && id.startsWith('evt_'));
}

function runPreflight(args) {
  return runCommand(process.execPath, [
    'scripts/stay-alive/preflight.mjs',
    '--agent', args.agent,
    '--limit', '50',
    '--draft-limit', '200',
    '--history-limit', '3',
    '--no-checkpoint',
    '--json',
    ...(args.requireBotlandLive ? ['--require-botland-live'] : []),
    ...(args.allowBotlandPollingFallback ? ['--allow-botland-polling-fallback'] : []),
    ...(path.resolve(args.runtimeRoot) === path.resolve(DEFAULT_RUNTIME) ? [] : ['--runtime-root', args.runtimeRoot])
  ], 30000);
}

function triggerLightCycle(args) {
  return runCommand(process.execPath, [
    'scripts/stay-alive/autonomous-social-cycle.mjs',
    '--agent', args.agent,
    '--cycle', 'light',
    '--execute',
    '--confirm-send', 'SEND_DRAFT',
    '--json',
    ...(path.resolve(args.runtimeRoot) === path.resolve(DEFAULT_RUNTIME) ? [] : ['--runtime-root', args.runtimeRoot])
  ], 180000);
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive event wakeup (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only_event_check: ${report.event_check.ok ? 'ok' : 'failed'}`);
  lines.push(`events_seen: ${report.events_seen_count}`);
  lines.push(`unprocessed_events: ${report.unprocessed_event_count}`);
  lines.push(`latest_seen_event_id: ${report.latest_seen_event_id ?? 'none'}`);
  lines.push(`triggered: ${report.triggered ? 'yes' : 'no'}`);
  lines.push(`trigger_reason: ${report.trigger_reason}`);
  if (report.trigger_result) {
    lines.push(`trigger_ok: ${report.trigger_result.ok ? 'yes' : 'no'}`);
    lines.push(`trigger_status: ${report.trigger_result.status ?? 'n/a'}`);
  }
  if (report.unprocessed_preview.length > 0) {
    lines.push('unprocessed_preview:');
    for (const event of report.unprocessed_preview) {
      lines.push(`- ${event.event_id} ${event.event_type ?? 'event'} ${event.created_at ?? ''}`);
    }
  }
  return lines.join('\n');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const daemonState = readJsonIfExists(path.join(agentDir, 'daemon_state.json'), {
    processed_event_ids: [],
    last_seen_event_id: null
  });
  const latestLedger = latestWakeupLedger(agentDir);
  const cooldownUntil = latestLedger?.generated_at
    ? new Date(new Date(latestLedger.generated_at).getTime() + args.cooldownMinutes * 60 * 1000)
    : null;
  const cooldownActive = Boolean(cooldownUntil && cooldownUntil.getTime() > Date.now());
  const processed = new Set(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []);
  const hasEventBaseline = botlandEventBaselineReady(daemonState);
  const eventCheck = args.noBotland
    ? { command: 'botland events list --json', ok: true, status: 0, stdout_json: { events: [] }, stdout_preview: '', stderr_preview: '' }
    : runBotlandIntent(BOTLAND_INTENTS.EVENTS_LIST, { limit: args.eventLimit }, { timeoutMs: 25000, agent: args.agent });
  const events = extractEvents(eventCheck);
  const unprocessed = events
    .map((event) => ({
      raw: event,
      event_id: getEventId(event),
      event_type: event.event_type ?? event.type ?? event.payload?.event_type ?? event.payload?.type ?? null,
      created_at: getEventTimestamp(event) || null
    }))
    .filter((event) => event.event_id && !processed.has(event.event_id));
  const baselineEventIds = events.map((event) => getEventId(event)).filter(Boolean);
  const initializedBaseline = args.record && eventCheck.ok && !hasEventBaseline && baselineEventIds.length > 0;
  if (initializedBaseline) {
    daemonState.processed_event_ids = [...new Set([...(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []), ...baselineEventIds])];
    daemonState.last_seen_botland_event_id = latestSeenEventId(events);
    daemonState.updated_at = generatedAt;
    writeJson(path.join(agentDir, 'daemon_state.json'), daemonState);
  }
  const shouldTrigger = args.run && eventCheck.ok && hasEventBaseline && unprocessed.length > 0 && !cooldownActive;
  const preflight = shouldTrigger ? runPreflight(args) : null;
  const preflightPass = preflight?.stdout_json?.verdict?.pass === true;
  const triggerResult = shouldTrigger && preflightPass ? triggerLightCycle(args) : null;
  const triggerReason = !args.run
    ? 'run_flag_not_set'
    : !eventCheck.ok
      ? 'event_read_failed'
    : !hasEventBaseline
      ? (initializedBaseline ? 'event_baseline_initialized' : 'event_baseline_missing')
      : cooldownActive
        ? 'cooldown_active'
      : unprocessed.length === 0
        ? 'no_unprocessed_events'
        : !preflightPass
          ? 'preflight_failed'
          : 'unprocessed_events_detected';
  const report = {
    generated_at: generatedAt,
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    local_only: true,
    external_write: false,
    event_check: {
      command: eventCheck.command,
      ok: eventCheck.ok,
      status: eventCheck.status,
      stderr_preview: eventCheck.stderr_preview
    },
    event_baseline_ready: hasEventBaseline,
    event_baseline_initialized: initializedBaseline,
    cooldown: {
      minutes: args.cooldownMinutes,
      active: cooldownActive,
      latest_triggered_at: latestLedger?.generated_at ?? null,
      until: cooldownUntil?.toISOString() ?? null
    },
    events_seen_count: events.length,
    unprocessed_event_count: unprocessed.length,
    latest_seen_event_id: latestSeenEventId(events) ?? daemonState.last_seen_event_id ?? null,
    unprocessed_preview: unprocessed.slice(0, 10).map((event) => ({
      event_id: event.event_id,
      event_type: event.event_type,
      created_at: event.created_at
    })),
    preflight: preflight
      ? {
          ok: preflight.ok,
          pass: preflight.stdout_json?.verdict?.pass === true,
          level: preflight.stdout_json?.verdict?.level ?? null,
          safety_findings: preflight.stdout_json?.verdict?.safety_findings ?? [],
          stderr_preview: preflight.stderr_preview
        }
      : null,
    triggered: Boolean(triggerResult?.ok),
    trigger_reason: triggerReason,
    trigger_result: triggerResult
      ? {
          command: triggerResult.command,
          ok: triggerResult.ok,
          status: triggerResult.status,
          stdout_json: triggerResult.stdout_json,
          stderr_preview: triggerResult.stderr_preview
        }
      : null
  };
  if (args.record) {
    report.ledger_path = writeWakeupLedger(agentDir, report);
  }
  console.log(args.format === 'json' ? JSON.stringify(report, null, 2) : formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
