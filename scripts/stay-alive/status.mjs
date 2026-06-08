#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 10,
    draftLimit: null,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    includeApplied: false,
    showText: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--draft-limit') args.draftLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--include-applied') args.includeApplied = true;
    else if (arg === '--show-text') args.showText = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  if (args.draftLimit === null) {
    args.draftLimit = Math.max(args.limit, 200);
  }
  if (!Number.isInteger(args.draftLimit) || args.draftLimit < 1) {
    throw new Error('--draft-limit must be a positive integer');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/status.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Number of recent runs to inspect. Default: 10
  --draft-limit <n>     Number of recent runs to inspect for drafts. Default: max(limit, 200)
  --runtime-root <dir>  Runtime agents directory.
  --include-applied     Include drafts with sent/dry-run action artifacts.
  --show-text           Include full draft text. Default redacts to previews.
  --help                Show this help.
`);
}

function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
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

function preview(text, limit = 120) {
  if (!text) return '';
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function runtimeRootArg(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? ''
    : ` --runtime-root ${args.runtimeRoot}`;
}

function draftKey(runId, draftIndex) {
  return `${runId}:${draftIndex}`;
}

function readActionIndex(agentDir) {
  const actionsDir = path.join(agentDir, 'actions');
  const index = new Map();
  if (!existsSync(actionsDir)) return index;

  const actionFiles = readdirSync(actionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(actionsDir, name))
    .sort();

  for (const file of actionFiles) {
    const action = JSON.parse(readFileSync(file, 'utf8'));
    if (!action.run_id || !Number.isInteger(action.draft_index)) continue;

    const key = draftKey(action.run_id, action.draft_index);
    const previous = index.get(key);
    const record = {
      action_id: action.action_id,
      action_path: path.relative(WORKSPACE, file),
      created_at: action.created_at,
      status: action.status ?? null,
      dry_run: Boolean(action.dry_run),
      approved: action.status === 'approved',
      dismissed: action.status === 'dismissed',
      sent: Boolean(!action.dry_run && action.result?.ok),
      failed: Boolean(!action.dry_run && action.result && !action.result.ok),
      send_status: action.result?.status ?? null
    };

    if (!previous || record.sent || (!previous.sent && record.created_at > previous.created_at)) {
      index.set(key, record);
    }
  }

  return index;
}

function summarizeRun(run) {
  const failedChecks = (run.inputs?.botland_checks ?? []).filter((check) => !check.ok);
  const identity = (run.observations ?? []).find((item) => item.topic === 'botland_identity') ?? null;
  const drafts = Array.isArray(run.drafts) ? run.drafts : [];
  const confirmationDrafts = drafts.filter((draft) => draft.requires_confirmation);

  return {
    run_id: run.run_id,
    created_at: run.created_at,
    cycle: run.cycle,
    dry_run: run.dry_run,
    botland_checks_ok: failedChecks.length === 0,
    failed_botland_checks: failedChecks.map((check) => check.command),
    identity_status: identity
      ? {
          severity: identity.severity,
          expected_citizen_id: identity.expected_citizen_id ?? null,
          actual_citizen_id: identity.actual_citizen_id ?? null
        }
      : null,
    chosen_action_type: run.chosen_action?.type ?? null,
    requires_confirmation: run.chosen_action?.requires_confirmation ?? false,
    draft_count: drafts.length,
    confirmation_draft_count: confirmationDrafts.length,
    policy_gate_reason: run.policy_gate?.reason ?? null,
    external_action_count: Array.isArray(run.external_actions) ? run.external_actions.length : 0,
    next_check_after: run.next_check_after
  };
}

function buildDraftQueue(runFiles, actionIndex, args) {
  const drafts = [];
  let totalDraftCount = 0;
  let appliedDraftCount = 0;

  for (const file of runFiles) {
    const run = JSON.parse(readFileSync(file, 'utf8'));
    const runDrafts = Array.isArray(run.drafts) ? run.drafts : [];
    totalDraftCount += runDrafts.length;

    runDrafts.forEach((draft, index) => {
      const action = actionIndex.get(draftKey(run.run_id, index)) ?? null;
      const computedStatus = action?.dismissed
        ? 'dismissed'
        : action?.approved
        ? 'approved'
        : action?.sent
        ? 'sent'
        : action?.failed
          ? 'send_failed'
          : action
            ? 'applied_dry_run'
            : draft.status ?? 'draft';
      if (action) appliedDraftCount += 1;
      if (!args.includeApplied && action && computedStatus !== 'approved') return;

      drafts.push({
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        draft_index: index,
        created_at: run.created_at,
        type: draft.type,
        status: computedStatus,
        ready_for_send: draft.ready_for_send === true,
        requires_confirmation: draft.requires_confirmation,
        external_write: draft.external_write,
        target: draft.target,
        source_event_id: draft.source_event_id,
        source_message_id: draft.source_message_id,
        latest_action: action,
        source_text_preview: preview(draft.source_text_preview),
        draft_text: args.showText ? draft.draft_text : preview(draft.draft_text),
        apply_dry_run_command: `node scripts/stay-alive/apply-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index}`,
        apply_send_command: `node scripts/stay-alive/apply-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index} --confirm-send SEND_DRAFT`,
        approve_command: `node scripts/stay-alive/approve-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index}`,
        dismiss_command: `node scripts/stay-alive/dismiss-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index}`
      });
    });
  }

  return { drafts, totalDraftCount, appliedDraftCount };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  const daemonStatePath = path.join(agentDir, 'daemon_state.json');
  const controlStatePath = path.join(agentDir, 'control_state.json');

  if (!existsSync(runsDir)) {
    throw new Error(`No runs directory found: ${runsDir}`);
  }

  const runFiles = readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, args.limit);
  const draftRunFiles = readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, args.draftLimit);

  const runs = runFiles
    .map((file) => JSON.parse(readFileSync(file, 'utf8')))
    .map(summarizeRun);
  const attentionRuns = runs.filter((run) => (
    !run.botland_checks_ok
    || run.external_action_count > 0
    || ['warning', 'error'].includes(run.identity_status?.severity)
  ));
  const actionIndex = readActionIndex(agentDir);
  const queue = buildDraftQueue(draftRunFiles, actionIndex, args);
  const daemonState = readJsonIfExists(daemonStatePath, null);
  const controlState = readJsonIfExists(controlStatePath, {
    schema_version: 1,
    agent_id: args.agent,
    paused: false,
    updated_at: null
  });
  const normalizedControlState = normalizeControlState(controlState);
  const latestRun = runs[0] ?? null;
  const latestRunNeedsAttention = latestRun
    ? (
        !latestRun.botland_checks_ok
        || latestRun.external_action_count > 0
        || ['warning', 'error'].includes(latestRun.identity_status?.severity)
      )
    : true;
  const pendingDrafts = queue.drafts.filter((draft) => draft.status === 'draft');
  const approvedDrafts = queue.drafts.filter((draft) => draft.status === 'approved');

  console.log(JSON.stringify({
    agent_id: args.agent,
    generated_at: new Date().toISOString(),
    health: {
      ok: !latestRunNeedsAttention,
      latest_run_needs_attention: latestRunNeedsAttention,
      historical_attention_run_count: attentionRuns.length,
      failed_or_attention_run_count: attentionRuns.length,
      pending_draft_count: pendingDrafts.length,
      approved_draft_count: approvedDrafts.length,
      visible_draft_count: queue.drafts.length,
      total_draft_count_in_window: queue.totalDraftCount,
      applied_draft_count_in_window: queue.appliedDraftCount,
      draft_run_window: args.draftLimit,
      external_action_count_in_window: runs.reduce((sum, run) => sum + run.external_action_count, 0)
    },
    control_state: {
      paused: normalizedControlState.paused === true,
      paused_raw: normalizedControlState.paused_raw === true,
      paused_at: normalizedControlState.paused_at ?? null,
      paused_by: normalizedControlState.paused_by ?? null,
      pause_reason: normalizedControlState.pause_reason ?? null,
      pause_until: normalizedControlState.pause_until ?? null,
      pause_expired: normalizedControlState.pause_expired === true,
      resumed_at: normalizedControlState.resumed_at ?? null,
      updated_at: normalizedControlState.updated_at ?? null
    },
    daemon_state: daemonState
      ? {
          run_count: daemonState.run_count ?? 0,
          last_run_id: daemonState.last_run_id ?? null,
          last_run_at_by_cycle: daemonState.last_run_at_by_cycle ?? {},
          next_check_after_by_cycle: daemonState.next_check_after_by_cycle ?? {},
          processed_event_count: Array.isArray(daemonState.processed_event_ids)
            ? daemonState.processed_event_ids.length
            : 0,
          last_seen_event_id: daemonState.last_seen_event_id ?? null
        }
      : null,
    latest_run: latestRun,
    drafts: queue.drafts,
    attention_runs: attentionRuns,
    recent_runs: runs
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
