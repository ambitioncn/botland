#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const DEFAULT_ACTION_TYPES = [
  'direct_message_reply',
  'public_moment',
  'community_reply',
  'friend_request_accept'
];
const DEFAULT_COMMAND_PATHS = [
  path.join(process.env.HOME ?? '', '.npm-global', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
].filter(Boolean);

function commandEnv() {
  const existingPath = process.env.PATH ?? '';
  const pathParts = existingPath.split(':').filter(Boolean);
  return {
    ...process.env,
    PATH: [...DEFAULT_COMMAND_PATHS, ...pathParts].filter((item, index, arr) => arr.indexOf(item) === index).join(':')
  };
}

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    cycle: 'light',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    execute: false,
    confirmSend: null,
    writeDaemonState: true,
    noMemory: false,
    allowedActionTypes: DEFAULT_ACTION_TYPES,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--cycle') args.cycle = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--confirm-send') args.confirmSend = argv[++i];
    else if (arg === '--no-write-daemon-state') args.writeDaemonState = false;
    else if (arg === '--no-memory') args.noMemory = true;
    else if (arg === '--allow-action-types') {
      args.allowedActionTypes = String(argv[++i] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['light', 'social', 'community'].includes(args.cycle)) {
    throw new Error('--cycle must be light, social, or community for autonomous social execution');
  }
  if (args.execute && args.confirmSend !== 'SEND_DRAFT') {
    throw new Error('External execution requires --confirm-send SEND_DRAFT');
  }
  if (args.allowedActionTypes.some((type) => !DEFAULT_ACTION_TYPES.includes(type))) {
    throw new Error(`Unknown allowed action type in --allow-action-types: ${args.allowedActionTypes.join(',')}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/autonomous-social-cycle.mjs [options]

Options:
  --agent <id>                 Agent id. Default: badclaw
  --cycle <type>               light | social | community. Default: light
  --runtime-root <dir>         Runtime agents directory.
  --execute                    Execute the selected action intention if tool supervision allows it.
  --confirm-send SEND_DRAFT    Required with --execute.
  --allow-action-types <csv>   Allowed action types. Default: ${DEFAULT_ACTION_TYPES.join(',')}
  --no-write-daemon-state      Do not update daemon_state from run-cycle.
  --no-memory                  Disable memory retrieval for fixture runs.
  --json                       Print JSON instead of text.

This command orchestrates one autonomous social cycle:
run-cycle -> selected action_intention -> apply-action -> inspect-send ->
action-outcome. It never bypasses preflight, identity checks, tool supervision,
the explicit SEND_DRAFT execution token, local ledgers, or post-send inspection.
`);
}

function runStep(label, commandArgs, options = {}) {
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: WORKSPACE,
    env: commandEnv(),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 90000,
    maxBuffer: 4 * 1024 * 1024
  });
  const stdout = result.stdout ? result.stdout.trim() : '';
  const stderr = result.stderr ? result.stderr.trim() : '';
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }
  return {
    label,
    command: [process.execPath, ...commandArgs].join(' '),
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout_json: parsed,
    stdout_preview: stdout.slice(0, 1000),
    stderr_preview: stderr.slice(0, 1000)
  };
}

function runtimeRootArgs(args) {
  return path.resolve(args.runtimeRoot) === path.resolve(DEFAULT_RUNTIME_ROOT)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function runCycle(args) {
  return runStep('run-cycle', [
    'scripts/stay-alive/run-cycle.mjs',
    '--agent', args.agent,
    '--cycle', args.cycle,
    '--dry-run',
    ...(args.writeDaemonState ? ['--write-daemon-state'] : []),
    ...(args.noMemory ? ['--no-memory'] : []),
    ...runtimeRootArgs(args)
  ]);
}

function selectedIntention(run, allowedActionTypes) {
  const intentions = Array.isArray(run?.action_intentions) ? run.action_intentions : [];
  const selectedCandidateId = run?.planner_decision_trace?.selected_candidate_id
    ?? run?.action_selection?.selected_candidate_id
    ?? null;
  const selected = intentions.find((intention) => {
    const candidateId = intention?.planner_decision_trace_ref?.candidate_id ?? null;
    return candidateId && selectedCandidateId && candidateId === selectedCandidateId;
  }) ?? null;
  if (!selected) return null;
  if (!allowedActionTypes.includes(selected.action_type)) return null;
  return selected;
}

function applyAction(args, run, intention) {
  return runStep(args.execute ? 'apply-action execute' : 'apply-action dry-run', [
    'scripts/stay-alive/apply-action.mjs',
    '--agent', args.agent,
    '--run', run.run_id,
    '--intention-id', intention.intention_id,
    ...(args.execute ? ['--confirm-send', args.confirmSend] : []),
    ...runtimeRootArgs(args)
  ]);
}

function inspectSend(args, actionId) {
  return runStep('inspect-send', [
    'scripts/stay-alive/inspect-send.mjs',
    '--agent', args.agent,
    '--action-id', actionId,
    '--inspected-by', 'autonomous-social-cycle',
    '--note', 'autonomous social execution inspected immediately after successful tool-supervised action',
    '--json',
    ...runtimeRootArgs(args)
  ]);
}

function actionOutcome(args, actionId) {
  return runStep('action-outcome', [
    'scripts/stay-alive/action-outcome.mjs',
    '--agent', args.agent,
    '--action-id', actionId,
    '--json',
    ...runtimeRootArgs(args)
  ]);
}

function updateRateLimits(args, actionReport) {
  if (!args.execute || actionReport?.send_result?.ok !== true) return null;
  const lifeStatePath = path.join(args.runtimeRoot, args.agent, 'life_state.json');
  const daemonStatePath = path.join(args.runtimeRoot, args.agent, 'daemon_state.json');
  const updated = {
    life_state_path: null,
    daemon_state_path: null,
    updated_at: null,
    action_type: null,
    fields: []
  };
  if (!existsSync(lifeStatePath)) return null;
  const lifeState = JSON.parse(readFileSync(lifeStatePath, 'utf8'));
  const now = new Date().toISOString();
  const actionType = actionReport.external_action_record?.action_type ?? actionReport.action_intention?.action_type ?? null;
  lifeState.updated_at = now;
  lifeState.rate_limits = {
    ...(lifeState.rate_limits ?? {}),
    last_external_write_at: now
  };
  if (actionType === 'public_moment') lifeState.rate_limits.last_public_post_at = now;
  if (actionType === 'community_reply' || actionType === 'community_post') lifeState.rate_limits.last_community_write_at = now;
  if (actionType === 'direct_message_reply') lifeState.rate_limits.last_direct_message_at = now;
  if (actionType === 'friend_request_accept') lifeState.rate_limits.last_friend_action_at = now;
  writeFileSync(lifeStatePath, `${JSON.stringify(lifeState, null, 2)}\n`);
  updated.life_state_path = path.relative(WORKSPACE, lifeStatePath);
  updated.updated_at = now;
  updated.action_type = actionType;
  updated.fields.push('updated_at', 'rate_limits.last_external_write_at');

  const sourceEventId = actionReport.source_event_id
    ?? actionReport.external_action_record?.source_event_id
    ?? actionReport.action_intention?.proposed_action?.source_event_id
    ?? actionReport.action_intention?.source?.event_id
    ?? null;
  if (sourceEventId && existsSync(daemonStatePath)) {
    const daemonState = JSON.parse(readFileSync(daemonStatePath, 'utf8'));
    const processed = new Set(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []);
    processed.add(sourceEventId);
    daemonState.updated_at = now;
    daemonState.processed_event_ids = [...processed].slice(-200);
    writeFileSync(daemonStatePath, `${JSON.stringify(daemonState, null, 2)}\n`);
    updated.daemon_state_path = path.relative(WORKSPACE, daemonStatePath);
    updated.fields.push('daemon_state.processed_event_ids');
  }

  return updated;
}

function textReport(report) {
  const lines = [
    `Stay-Alive autonomous social cycle (${report.agent_id}/${report.cycle})`,
    `generated_at: ${report.generated_at}`,
    `execute: ${report.execute ? 'yes' : 'no'}`,
    `run_id: ${report.run?.run_id ?? 'none'}`,
    `selected_intention: ${report.selected_intention?.intention_id ?? 'none'}`,
    `selected_action_type: ${report.selected_intention?.action_type ?? 'none'}`,
    `apply_ok: ${report.apply?.ok === true ? 'yes' : report.apply ? 'no' : 'not_run'}`,
    `send_ok: ${report.apply?.stdout_json?.send_result?.ok === true ? 'yes' : report.execute ? 'no' : 'not_attempted'}`,
    `inspection_ok: ${report.inspection?.ok === true ? 'yes' : report.inspection ? 'no' : 'not_needed'}`,
    `outcome_ok: ${report.outcome?.ok === true ? 'yes' : report.outcome ? 'no' : 'not_needed'}`,
    `rate_limit_update: ${report.rate_limit_update ? 'yes' : 'no'}`,
    `external_write_attempted: ${report.external_write_attempted ? 'yes' : 'no'}`
  ];
  if (report.block_reason) lines.push(`block_reason: ${report.block_reason}`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const cycleStep = runCycle(args);
  if (!cycleStep.ok || !cycleStep.stdout_json) {
    const report = {
      generated_at: generatedAt,
      agent_id: args.agent,
      cycle: args.cycle,
      execute: args.execute,
      run_step: cycleStep,
      pass: false,
      block_reason: 'run_cycle_failed'
    };
    output(report, args);
    process.exit(1);
  }

  const run = cycleStep.stdout_json;
  const intention = selectedIntention(run, args.allowedActionTypes);
  const report = {
    generated_at: generatedAt,
    agent_id: args.agent,
    cycle: args.cycle,
    execute: args.execute,
    allowed_action_types: args.allowedActionTypes,
    run: {
      run_id: run.run_id,
      run_path: run.run_path,
      chosen_action: run.chosen_action,
      action_intention_count: Array.isArray(run.action_intentions) ? run.action_intentions.length : 0
    },
    selected_intention: intention
      ? {
          intention_id: intention.intention_id,
          action_type: intention.action_type,
          source_event_id: intention.proposed_action?.source_event_id ?? intention.source?.event_id ?? null,
          target: intention.proposed_action?.target ?? intention.target ?? null
        }
      : null,
    apply: null,
    inspection: null,
    outcome: null,
    rate_limit_update: null,
    external_write_attempted: false,
    pass: true,
    block_reason: null
  };

  if (!intention) {
    report.block_reason = 'no_allowed_selected_action_intention';
    output(report, args);
    return;
  }

  const apply = applyAction(args, run, intention);
  report.apply = apply;
  report.external_write_attempted = args.execute;
  if (!apply.ok || !apply.stdout_json) {
    report.pass = false;
    report.block_reason = 'apply_action_failed';
    output(report, args);
    process.exit(1);
  }

  const sendResult = apply.stdout_json.send_result;
  if (args.execute && sendResult?.ok === true) {
    const actionId = apply.stdout_json.action_id;
    report.inspection = inspectSend(args, actionId);
    if (!report.inspection.ok) {
      report.pass = false;
      report.block_reason = 'post_send_inspection_failed';
      output(report, args);
      process.exit(1);
    }
    report.outcome = actionOutcome(args, actionId);
    if (!report.outcome.ok) {
      report.pass = false;
      report.block_reason = 'action_outcome_failed';
      output(report, args);
      process.exit(1);
    }
    report.rate_limit_update = updateRateLimits(args, apply.stdout_json);
  }

  output(report, args);
}

function output(report, args) {
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(textReport(report));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
