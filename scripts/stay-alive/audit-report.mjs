#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 50,
    draftLimit: null,
    historyLimit: 3,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    checkpointDir: null,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--draft-limit') args.draftLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--history-limit') args.historyLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--checkpoint-dir') args.checkpointDir = path.resolve(argv[++i]);
    else if (arg === '--json') args.format = 'json';
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
  if (!Number.isInteger(args.historyLimit) || args.historyLimit < 1) {
    throw new Error('--history-limit must be a positive integer');
  }
  if (!args.checkpointDir) {
    args.checkpointDir = path.join(args.runtimeRoot, args.agent, 'checkpoints');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/audit-report.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Number of recent runs to audit. Default: 50
  --draft-limit <n>     Number of recent runs to inspect for drafts. Default: max(limit, 200)
  --history-limit <n>   Number of recent checkpoints to audit. Default: 3
  --runtime-root <dir>  Runtime agents directory.
  --checkpoint-dir <dir>
                        Directory containing checkpoint artifacts.
  --json                Print JSON instead of audit text.
  --help                Show this help.

This command is read-only. It audits run artifacts, local draft action artifacts,
and recent checkpoint artifacts; it never writes action artifacts and never sends
BotLand messages.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return readJson(file);
}

function draftKey(runId, draftIndex) {
  return `${runId}:${draftIndex}`;
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort();
}

function runtimeRootArgs(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function runJson(script, scriptArgs, options = {}) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs, '--json'], {
    cwd: WORKSPACE,
    encoding: 'utf8'
  });

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(stderr || stdout || `Command failed: ${script}`);
  }

  if (!stdout) return null;
  return JSON.parse(stdout);
}

function compactRun(run, file) {
  const failedChecks = (run.inputs?.botland_checks ?? []).filter((check) => !check.ok);
  const identity = (run.observations ?? []).find((item) => item.topic === 'botland_identity') ?? null;
  const drafts = Array.isArray(run.drafts) ? run.drafts : [];
  const externalActions = Array.isArray(run.external_actions) ? run.external_actions : [];

  return {
    run_id: run.run_id,
    run_path: path.relative(WORKSPACE, file),
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
    draft_count: drafts.length,
    confirmation_draft_count: drafts.filter((draft) => draft.requires_confirmation).length,
    ready_draft_count: drafts.filter((draft) => draft.ready_for_send === true).length,
    external_action_count: externalActions.length,
    external_actions: externalActions
  };
}

function compactAction(action, file) {
  return {
    action_id: action.action_id ?? path.basename(file, '.json'),
    action_path: path.relative(WORKSPACE, file),
    created_at: action.created_at ?? null,
    run_id: action.run_id ?? null,
    draft_index: Number.isInteger(action.draft_index) ? action.draft_index : null,
    status: action.status ?? null,
    dry_run: Boolean(action.dry_run),
    external_write: Boolean(action.external_write),
    result_ok: action.result?.ok ?? null,
    result_status: action.result?.status ?? null,
    draft_text_sha256: action.draft_text_sha256 ?? null,
    approved_by: action.approved_by ?? null,
    inspected_action_id: action.inspected_action_id ?? null
  };
}

function isInspectionAction(action) {
  return action.status === 'successful_send_inspected'
    || String(action.action_id ?? '').startsWith('send_inspect_');
}

function inspectedSendActionIds(actions) {
  return new Set(actions
    .filter(isInspectionAction)
    .map((action) => action.inspected_action_id)
    .filter((id) => typeof id === 'string' && id.length > 0));
}

function latestByDraft(actions) {
  const index = new Map();
  for (const action of actions) {
    if (!action.run_id || !Number.isInteger(action.draft_index)) continue;
    const key = draftKey(action.run_id, action.draft_index);
    const previous = index.get(key);
    if (!previous || String(action.created_at ?? '') > String(previous.created_at ?? '')) {
      index.set(key, action);
    }
  }
  return index;
}

function classifyDraft(draft, action, actionHistory = []) {
  if (!action) return draft.status ?? 'draft';
  if (action.status === 'dismissed') return 'dismissed';
  if (action.status === 'approved') return 'approved';
  if (actionHistory.some((item) => !item.dry_run && item.result_ok === true)) return 'sent';
  if (!action.dry_run && action.result_ok === true) return 'sent';
  if (!action.dry_run && action.result_ok === false) return 'send_failed';
  return 'applied_dry_run';
}

function buildDraftAudit(runs, latestActionByDraft, actions) {
  const drafts = [];
  const counts = {
    total: 0,
    pending: 0,
    approved: 0,
    dismissed: 0,
    sent: 0,
    send_failed: 0,
    applied_dry_run: 0,
    ready_for_send: 0,
    requires_confirmation: 0
  };

  for (const run of runs) {
    const rawRun = readJson(path.join(WORKSPACE, run.run_path));
    const runDrafts = Array.isArray(rawRun.drafts) ? rawRun.drafts : [];
    for (const [index, draft] of runDrafts.entries()) {
      const key = draftKey(run.run_id, index);
      const action = latestActionByDraft.get(key) ?? null;
      const actionHistory = actions.filter((item) => draftKey(item.run_id, item.draft_index) === key);
      const status = classifyDraft(draft, action, actionHistory);
      counts.total += 1;
      if (status === 'draft') {
        counts.pending += 1;
      } else if (Object.prototype.hasOwnProperty.call(counts, status)) {
        counts[status] += 1;
      }
      if (draft.ready_for_send === true) counts.ready_for_send += 1;
      if (draft.requires_confirmation === true) counts.requires_confirmation += 1;

      drafts.push({
        run_id: run.run_id,
        draft_index: index,
        created_at: rawRun.created_at,
        status,
        type: draft.type ?? null,
        ready_for_send: draft.ready_for_send === true,
        requires_confirmation: draft.requires_confirmation === true,
        external_write: draft.external_write === true,
        source_event_id: draft.source_event_id ?? null,
        source_message_id: draft.source_message_id ?? null,
        latest_action_id: action?.action_id ?? null
      });
    }
  }

  return { counts, drafts };
}

function loadCheckpointHistory(args) {
  return runJson('scripts/stay-alive/checkpoint-list.mjs', [
    '--agent',
    args.agent,
    '--limit',
    String(args.historyLimit),
    '--compare',
    ...runtimeRootArgs(args),
    '--checkpoint-dir',
    args.checkpointDir
  ]);
}

function loadRunVerification(args) {
  return runJson('scripts/stay-alive/run-verify.mjs', [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeRootArgs(args)
  ], { allowFailure: true });
}

function loadDraftStateVerification(args) {
  return runJson('scripts/stay-alive/draft-state-verify.mjs', [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeRootArgs(args)
  ], { allowFailure: true });
}

function loadLifeStateVerification(args) {
  return runJson('scripts/stay-alive/life-state-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { allowFailure: true });
}

function loadDaemonStateVerification(args) {
  return runJson('scripts/stay-alive/daemon-state-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { allowFailure: true });
}

function loadArtifactInventory(args) {
  return runJson('scripts/stay-alive/artifact-inventory.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { allowFailure: true });
}

function loadRuntimeStorageVerification(args) {
  return runJson('scripts/stay-alive/runtime-storage-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { allowFailure: true });
}

function loadSystemdUnitVerification(args) {
  return runJson('scripts/stay-alive/systemd-unit-verify.mjs', [
    '--agent',
    args.agent,
    '--workspace',
    WORKSPACE
  ], { allowFailure: true });
}

function loadSystemdRuntimeVerification(args) {
  return runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { allowFailure: true });
}

function summarizeCheckpointAudit(history) {
  const checkpoints = history.checkpoints ?? [];
  const summaries = checkpoints.map((checkpoint) => checkpoint.summary ?? {});
  const checkpointsWithExternalEvidence = checkpoints.filter((checkpoint) => {
    const summary = checkpoint.summary ?? {};
    const uninspectedSuccessfulSendCount = summary.uninspected_successful_send_count ?? 0;
    return (summary.external_action_count_in_window ?? 0) > 0
      || uninspectedSuccessfulSendCount > 0
      || (summary.external_write_action_count ?? 0) > 0
      || checkpoint.external_write === true;
  });
  const checkpointsWithFailedAudit = checkpoints.filter((checkpoint) => {
    const summary = checkpoint.summary ?? {};
    return summary.audit_pass === false
      || summary.control_audit_pass === false
      || summary.life_state_verification_pass === false
      || summary.action_verification_pass === false
      || summary.draft_state_verification_pass === false
      || summary.run_verification_pass === false
      || summary.daemon_state_verification_pass === false
      || summary.artifact_inventory_pass === false
      || summary.runtime_storage_verification_pass === false
      || summary.systemd_unit_verification_pass === false
      || summary.systemd_runtime_verification_pass === false
      || checkpoint.checkpoint_path_matches_id === false;
  });
  const checkpointsWithFailedActionVerification = checkpoints.filter((checkpoint) => {
    const summary = checkpoint.summary ?? {};
    return summary.action_verification_pass === false
      || (summary.action_verification_error_count ?? 0) > 0
      || (summary.action_preflight_gate_missing_count ?? 0) > 0
      || (summary.action_preflight_gate_failed_count ?? 0) > 0
      || (summary.action_preflight_gate_stale_count ?? 0) > 0
      || (summary.action_path_mismatch_count ?? 0) > 0
      || (summary.action_draft_reference_error_count ?? 0) > 0
      || (summary.action_draft_text_hash_mismatch_count ?? 0) > 0;
  });
  const checkpointsWithFailedDraftStateVerification = checkpoints.filter((checkpoint) => {
    const summary = checkpoint.summary ?? {};
    return summary.draft_state_verification_pass === false
      || (summary.draft_state_verification_error_count ?? 0) > 0
      || (summary.draft_state_conflict_error_count ?? 0) > 0
      || (summary.draft_state_approved_hash_mismatch_count ?? 0) > 0
      || (summary.draft_state_ready_safety_error_count ?? 0) > 0
      || (summary.draft_state_approved_queue_overflow_count ?? 0) > 0;
  });
  const latest = checkpoints[0] ?? null;

  return {
    checkpoint_count: history.checkpoint_count ?? 0,
    latest_checkpoint_id: latest?.checkpoint_id ?? null,
    latest_generated_at: latest?.generated_at ?? null,
    latest_summary: latest?.summary ?? null,
    newest_two_change_count: history.compare_newest_two?.change_count ?? null,
    newest_two_changes: history.compare_newest_two?.changes ?? [],
    checkpoint_path_mismatch_count: history.checkpoint_path_mismatch_count ?? 0,
    checkpoint_external_evidence_count: checkpointsWithExternalEvidence.length,
    checkpoint_failed_audit_count: checkpointsWithFailedAudit.length,
    checkpoint_action_verification_failure_count: checkpointsWithFailedActionVerification.length,
    checkpoint_draft_state_verification_failure_count: checkpointsWithFailedDraftStateVerification.length,
    checkpoints_with_external_evidence: checkpointsWithExternalEvidence.map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpoint_id,
      generated_at: checkpoint.generated_at,
      external_write: checkpoint.external_write,
      summary: checkpoint.summary
    })),
    checkpoints_with_failed_audit: checkpointsWithFailedAudit.map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpoint_id,
      generated_at: checkpoint.generated_at,
      summary: checkpoint.summary
    })),
    checkpoints_with_failed_action_verification: checkpointsWithFailedActionVerification.map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpoint_id,
      generated_at: checkpoint.generated_at,
      summary: checkpoint.summary
    })),
    checkpoints_with_failed_draft_state_verification: checkpointsWithFailedDraftStateVerification.map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpoint_id,
      generated_at: checkpoint.generated_at,
      summary: checkpoint.summary
    })),
    summary_totals: {
      external_action_count_in_window: summaries.reduce(
        (sum, summary) => sum + (summary.external_action_count_in_window ?? 0),
        0
      ),
      successful_send_count: summaries.reduce(
        (sum, summary) => sum + (summary.successful_send_count ?? 0),
        0
      ),
      inspected_successful_send_count: summaries.reduce(
        (sum, summary) => sum + (summary.inspected_successful_send_count ?? 0),
        0
      ),
      uninspected_successful_send_count: summaries.reduce(
        (sum, summary) => sum + (summary.uninspected_successful_send_count ?? 0),
        0
      ),
      successful_send_inspection_count: summaries.reduce(
        (sum, summary) => sum + (summary.successful_send_inspection_count ?? 0),
        0
      ),
      external_write_action_count: summaries.reduce(
        (sum, summary) => sum + (summary.external_write_action_count ?? 0),
        0
      ),
      action_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.action_verification_error_count ?? 0),
        0
      ),
      life_state_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_verification_error_count ?? 0),
        0
      ),
      life_state_write_policy_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_write_policy_error_count ?? 0),
        0
      ),
      life_state_unsafe_allowed_write_type_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_unsafe_allowed_write_type_count ?? 0),
        0
      ),
      life_state_writes_enabled_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_writes_enabled_count ?? 0),
        0
      ),
      life_state_rate_limit_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_rate_limit_error_count ?? 0),
        0
      ),
      life_state_unattended_policy_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_unattended_policy_error_count ?? 0),
        0
      ),
      life_state_unattended_policy_enabled_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_unattended_policy_enabled_count ?? 0),
        0
      ),
      life_state_botland_identity_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.life_state_botland_identity_error_count ?? 0),
        0
      ),
      action_preflight_gate_missing_count: summaries.reduce(
        (sum, summary) => sum + (summary.action_preflight_gate_missing_count ?? 0),
        0
      ),
      action_preflight_gate_failed_count: summaries.reduce(
        (sum, summary) => sum + (summary.action_preflight_gate_failed_count ?? 0),
        0
      ),
      action_preflight_gate_stale_count: summaries.reduce(
        (sum, summary) => sum + (summary.action_preflight_gate_stale_count ?? 0),
        0
      ),
      action_path_mismatch_count: summaries.reduce(
        (sum, summary) => sum + (summary.action_path_mismatch_count ?? 0),
        0
      ),
      action_draft_reference_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.action_draft_reference_error_count ?? 0),
        0
      ),
      action_draft_text_hash_mismatch_count: summaries.reduce(
        (sum, summary) => sum + (summary.action_draft_text_hash_mismatch_count ?? 0),
        0
      ),
      draft_state_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.draft_state_verification_error_count ?? 0),
        0
      ),
      draft_state_conflict_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.draft_state_conflict_error_count ?? 0),
        0
      ),
      draft_state_approved_hash_mismatch_count: summaries.reduce(
        (sum, summary) => sum + (summary.draft_state_approved_hash_mismatch_count ?? 0),
        0
      ),
      draft_state_ready_safety_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.draft_state_ready_safety_error_count ?? 0),
        0
      ),
      run_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.run_verification_error_count ?? 0),
        0
      ),
      run_path_mismatch_count: summaries.reduce(
        (sum, summary) => sum + (summary.run_path_mismatch_count ?? 0),
        0
      ),
      run_external_action_count: summaries.reduce(
        (sum, summary) => sum + (summary.run_external_action_count ?? 0),
        0
      ),
      run_draft_safety_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.run_draft_safety_error_count ?? 0),
        0
      ),
      daemon_state_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.daemon_state_verification_error_count ?? 0),
        0
      ),
      daemon_state_run_reference_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.daemon_state_run_reference_error_count ?? 0),
        0
      ),
      daemon_state_processed_event_duplicate_count: summaries.reduce(
        (sum, summary) => sum + (summary.daemon_state_processed_event_duplicate_count ?? 0),
        0
      ),
      artifact_inventory_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.artifact_inventory_error_count ?? 0),
        0
      ),
      artifact_unknown_file_count: summaries.reduce(
        (sum, summary) => sum + (summary.artifact_unknown_file_count ?? 0),
        0
      ),
      artifact_unknown_dir_count: summaries.reduce(
        (sum, summary) => sum + (summary.artifact_unknown_dir_count ?? 0),
        0
      ),
      artifact_non_json_file_count: summaries.reduce(
        (sum, summary) => sum + (summary.artifact_non_json_file_count ?? 0),
        0
      ),
      artifact_json_parse_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.artifact_json_parse_error_count ?? 0),
        0
      ),
      runtime_storage_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.runtime_storage_verification_error_count ?? 0),
        0
      ),
      runtime_storage_disk_free_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.runtime_storage_disk_free_error_count ?? 0),
        0
      ),
      runtime_storage_oversized_file_count: summaries.reduce(
        (sum, summary) => sum + (summary.runtime_storage_oversized_file_count ?? 0),
        0
      ),
      systemd_unit_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_unit_verification_error_count ?? 0),
        0
      ),
      systemd_unit_preflight_gate_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_unit_preflight_gate_error_count ?? 0),
        0
      ),
      systemd_unit_runner_safety_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_unit_runner_safety_error_count ?? 0),
        0
      ),
      systemd_unit_timer_schedule_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_unit_timer_schedule_error_count ?? 0),
        0
      ),
      systemd_runtime_verification_error_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_runtime_verification_error_count ?? 0),
        0
      ),
      systemd_runtime_failed_service_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_runtime_failed_service_count ?? 0),
        0
      ),
      systemd_runtime_uninspected_failed_service_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_runtime_uninspected_failed_service_count ?? 0),
        0
      ),
      systemd_runtime_inspected_failed_service_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_runtime_inspected_failed_service_count ?? 0),
        0
      ),
      service_failure_inspection_count: summaries.reduce(
        (sum, summary) => sum + (summary.service_failure_inspection_count ?? 0),
        0
      ),
      service_failure_recovery_count: summaries.reduce(
        (sum, summary) => sum + (summary.service_failure_recovery_count ?? 0),
        0
      ),
      systemd_runtime_failed_timer_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_runtime_failed_timer_count ?? 0),
        0
      ),
      systemd_runtime_inactive_timer_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_runtime_inactive_timer_count ?? 0),
        0
      ),
      systemd_runtime_disabled_timer_count: summaries.reduce(
        (sum, summary) => sum + (summary.systemd_runtime_disabled_timer_count ?? 0),
        0
      )
    }
  };
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  const actionsDir = path.join(agentDir, 'actions');
  const daemonStatePath = path.join(agentDir, 'daemon_state.json');

  if (!existsSync(runsDir)) {
    throw new Error(`No runs directory found: ${runsDir}`);
  }

  const runFiles = listJsonFiles(runsDir).reverse().slice(0, args.limit);
  const draftRunFiles = listJsonFiles(runsDir).reverse().slice(0, args.draftLimit);
  const runs = runFiles.map((file) => compactRun(readJson(file), file));
  const draftRuns = draftRunFiles.map((file) => compactRun(readJson(file), file));
  const actionFiles = listJsonFiles(actionsDir);
  const actions = actionFiles.map((file) => compactAction(readJson(file), file));
  const actionStatusCounts = actions.reduce((counts, action) => {
    const status = action.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const latestAction = actions
    .slice()
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;
  const latestActionByDraft = latestByDraft(actions);
  const draftAudit = buildDraftAudit(draftRuns, latestActionByDraft, actions);
  const daemonState = readJsonIfExists(daemonStatePath, null);
  const checkpointHistory = loadCheckpointHistory(args);
  const checkpointAudit = summarizeCheckpointAudit(checkpointHistory);
  const lifeStateVerification = loadLifeStateVerification(args);
  const runVerification = loadRunVerification(args);
  const draftStateVerification = loadDraftStateVerification(args);
  const daemonStateVerification = loadDaemonStateVerification(args);
  const artifactInventory = loadArtifactInventory(args);
  const runtimeStorageVerification = loadRuntimeStorageVerification(args);
  const systemdUnitVerification = loadSystemdUnitVerification(args);
  const systemdRuntimeVerification = loadSystemdRuntimeVerification(args);

  const runsWithExternalActions = runs.filter((run) => run.external_action_count > 0);
  const failedBotlandRuns = runs.filter((run) => !run.botland_checks_ok);
  const identityAttentionRuns = runs.filter((run) => ['warning', 'error'].includes(run.identity_status?.severity));
  const successfulSends = actions.filter((action) => !action.dry_run && action.result_ok === true);
  const inspectedSendIds = inspectedSendActionIds(actions);
  const inspectedSuccessfulSends = successfulSends.filter((action) => inspectedSendIds.has(action.action_id));
  const uninspectedSuccessfulSends = successfulSends.filter((action) => !inspectedSendIds.has(action.action_id));
  const inspectionActions = actions.filter(isInspectionAction);
  const failedSends = actions.filter((action) => !action.dry_run && action.result_ok === false);
  const externalWriteActions = actions.filter((action) => action.external_write);
  const latestRun = runs[0] ?? null;

  const pass = runsWithExternalActions.length === 0
    && uninspectedSuccessfulSends.length === 0
    && externalWriteActions.length === 0
    && checkpointAudit.checkpoint_path_mismatch_count === 0
    && checkpointAudit.checkpoint_external_evidence_count === 0
    && checkpointAudit.checkpoint_failed_audit_count === 0
    && checkpointAudit.checkpoint_action_verification_failure_count === 0
    && lifeStateVerification.pass === true
    && draftStateVerification.pass === true
    && runVerification.pass === true
    && daemonStateVerification.pass === true
    && artifactInventory.pass === true
    && runtimeStorageVerification.pass === true
    && systemdUnitVerification.pass === true
    && systemdRuntimeVerification.pass === true;

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    window: {
      requested_limit: args.limit,
      requested_draft_limit: args.draftLimit,
      run_count: runs.length,
      draft_run_count: draftRuns.length,
      oldest_run_at: runs.length > 0 ? runs[runs.length - 1].created_at : null,
      newest_run_at: latestRun?.created_at ?? null
    },
    verdict: {
      pass,
      level: pass ? (failedBotlandRuns.length > 0 || identityAttentionRuns.length > 0 ? 'review' : 'ok') : 'stop',
      summary: pass
        ? 'No external writes or uninspected successful sends found in audited artifacts.'
        : 'External write evidence or uninspected successful send found; inspect before continuing.'
    },
    daemon_state: daemonState
      ? {
          run_count: daemonState.run_count ?? 0,
          last_run_id: daemonState.last_run_id ?? null,
          last_seen_event_id: daemonState.last_seen_event_id ?? null,
          processed_event_count: Array.isArray(daemonState.processed_event_ids)
            ? daemonState.processed_event_ids.length
            : 0
        }
      : null,
    life_state_verification: {
      pass: lifeStateVerification.pass,
      level: lifeStateVerification.level,
      error_count: lifeStateVerification.error_count,
      warning_count: lifeStateVerification.warning_count,
      missing: lifeStateVerification.missing,
      write_policy_error_count: lifeStateVerification.write_policy_error_count,
      unsafe_allowed_write_type_count: lifeStateVerification.unsafe_allowed_write_type_count,
      writes_enabled_count: lifeStateVerification.writes_enabled_count,
      rate_limit_error_count: lifeStateVerification.rate_limit_error_count,
      unattended_policy_error_count: lifeStateVerification.unattended_policy_error_count,
      unattended_policy_enabled_count: lifeStateVerification.unattended_policy_enabled_count,
      botland_identity_error_count: lifeStateVerification.botland_identity_error_count
    },
    daemon_state_verification: {
      pass: daemonStateVerification.pass,
      level: daemonStateVerification.level,
      error_count: daemonStateVerification.error_count,
      warning_count: daemonStateVerification.warning_count,
      missing: daemonStateVerification.missing,
      last_run_missing_count: daemonStateVerification.last_run_missing_count,
      last_run_not_latest_count: daemonStateVerification.last_run_not_latest_count,
      run_reference_error_count: daemonStateVerification.run_reference_error_count,
      processed_event_duplicate_count: daemonStateVerification.processed_event_duplicate_count
    },
    artifact_inventory: {
      pass: artifactInventory.pass,
      level: artifactInventory.level,
      error_count: artifactInventory.error_count,
      warning_count: artifactInventory.warning_count,
      unknown_runtime_file_count: artifactInventory.unknown_runtime_file_count,
      unknown_runtime_dir_count: artifactInventory.unknown_runtime_dir_count,
      non_json_artifact_file_count: artifactInventory.non_json_artifact_file_count,
      unexpected_subdir_count: artifactInventory.unexpected_subdir_count,
      json_parse_error_count: artifactInventory.json_parse_error_count,
      required_missing_count: artifactInventory.required_missing_count,
      directory_counts: artifactInventory.directory_counts
    },
    runtime_storage_verification: {
      pass: runtimeStorageVerification.pass,
      level: runtimeStorageVerification.level,
      error_count: runtimeStorageVerification.error_count,
      warning_count: runtimeStorageVerification.warning_count,
      disk_available_mb: runtimeStorageVerification.disk?.available_mb ?? null,
      disk_available_percent: runtimeStorageVerification.disk?.available_percent ?? null,
      runtime_total_mb: runtimeStorageVerification.runtime?.total_mb ?? null,
      runtime_file_count: runtimeStorageVerification.runtime?.file_count ?? 0,
      disk_free_error_count: runtimeStorageVerification.disk_free_error_count,
      oversized_file_count: runtimeStorageVerification.oversized_file_count,
      runtime_size_warning_count: runtimeStorageVerification.runtime_size_warning_count
    },
    systemd_unit_verification: {
      pass: systemdUnitVerification.pass,
      level: systemdUnitVerification.level,
      error_count: systemdUnitVerification.error_count,
      warning_count: systemdUnitVerification.warning_count,
      missing_service_count: systemdUnitVerification.missing_service_count,
      missing_timer_count: systemdUnitVerification.missing_timer_count,
      preflight_gate_error_count: systemdUnitVerification.preflight_gate_error_count,
      runner_safety_error_count: systemdUnitVerification.runner_safety_error_count,
      timer_schedule_error_count: systemdUnitVerification.timer_schedule_error_count
    },
    systemd_runtime_verification: {
      pass: systemdRuntimeVerification.pass,
      level: systemdRuntimeVerification.level,
      error_count: systemdRuntimeVerification.error_count,
      warning_count: systemdRuntimeVerification.warning_count,
      missing_service_count: systemdRuntimeVerification.missing_service_count,
      missing_timer_count: systemdRuntimeVerification.missing_timer_count,
      failed_service_count: systemdRuntimeVerification.failed_service_count,
      uninspected_failed_service_count: systemdRuntimeVerification.uninspected_failed_service_count,
      inspected_failed_service_count: systemdRuntimeVerification.inspected_failed_service_count,
      service_failure_inspection_count: systemdRuntimeVerification.service_failure_inspection_count,
      service_failure_recovery_count: systemdRuntimeVerification.service_failure_recovery_count,
      failed_timer_count: systemdRuntimeVerification.failed_timer_count,
      inactive_timer_count: systemdRuntimeVerification.inactive_timer_count,
      disabled_timer_count: systemdRuntimeVerification.disabled_timer_count
    },
    run_audit: {
      latest_run: latestRun,
      verification: {
        pass: runVerification.pass,
        level: runVerification.level,
        error_count: runVerification.error_count,
        warning_count: runVerification.warning_count,
        run_path_mismatch_count: runVerification.run_path_mismatch_count,
        external_action_run_count: runVerification.external_action_run_count,
        draft_safety_error_count: runVerification.draft_safety_error_count
      },
      external_action_count: runs.reduce((sum, run) => sum + run.external_action_count, 0),
      runs_with_external_actions: runsWithExternalActions,
      failed_botland_run_count: failedBotlandRuns.length,
      failed_botland_runs: failedBotlandRuns,
      identity_attention_run_count: identityAttentionRuns.length,
      identity_attention_runs: identityAttentionRuns,
      draft_count: runs.reduce((sum, run) => sum + run.draft_count, 0),
      confirmation_draft_count: runs.reduce((sum, run) => sum + run.confirmation_draft_count, 0),
      ready_draft_count: runs.reduce((sum, run) => sum + run.ready_draft_count, 0)
    },
    draft_state_verification: {
      pass: draftStateVerification.pass,
      level: draftStateVerification.level,
      error_count: draftStateVerification.error_count,
      warning_count: draftStateVerification.warning_count,
      conflict_error_count: draftStateVerification.conflict_error_count,
      approved_hash_mismatch_count: draftStateVerification.approved_hash_mismatch_count,
      ready_draft_safety_error_count: draftStateVerification.ready_draft_safety_error_count,
      approved_queue_overflow_count: draftStateVerification.approved_queue_overflow_count,
      counts: draftStateVerification.counts
    },
    action_audit: {
      action_count: actions.length,
      action_status_counts: actionStatusCounts,
      approved_count: actionStatusCounts.approved ?? 0,
      dismissed_count: actionStatusCounts.dismissed ?? 0,
      dry_run_action_count: actions.filter((action) => action.dry_run).length,
      successful_send_count: successfulSends.length,
      inspected_successful_send_count: inspectedSuccessfulSends.length,
      uninspected_successful_send_count: uninspectedSuccessfulSends.length,
      successful_send_inspection_count: inspectionActions.length,
      failed_send_count: failedSends.length,
      external_write_action_count: externalWriteActions.length,
      latest_action: latestAction,
      successful_sends: successfulSends,
      inspected_successful_sends: inspectedSuccessfulSends,
      uninspected_successful_sends: uninspectedSuccessfulSends,
      inspection_actions: inspectionActions,
      failed_sends: failedSends,
      external_write_actions: externalWriteActions
    },
    draft_audit: draftAudit,
    checkpoint_audit: checkpointAudit,
    recent_runs: runs
  };
}

function formatText(report) {
  const lines = [];
  const runAudit = report.run_audit;
  const actionAudit = report.action_audit;
  const draftAudit = report.draft_audit;
  const checkpointAudit = report.checkpoint_audit;
  const daemon = report.daemon_state ?? {};
  const lifeStateVerification = report.life_state_verification ?? {};
  const daemonVerification = report.daemon_state_verification ?? {};
  const artifactInventory = report.artifact_inventory ?? {};
  const runtimeStorage = report.runtime_storage_verification ?? {};
  const systemdUnitVerification = report.systemd_unit_verification ?? {};
  const systemdRuntimeVerification = report.systemd_runtime_verification ?? {};

  lines.push(`Stay-Alive audit report (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${report.read_only ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.verdict.level}`);
  lines.push(`- pass: ${report.verdict.pass ? 'yes' : 'no'}`);
  lines.push(`- summary: ${report.verdict.summary}`);
  lines.push('');
  lines.push('Window');
  lines.push(`- runs: ${report.window.run_count}/${report.window.requested_limit}`);
  lines.push(`- draft_runs: ${report.window.draft_run_count}/${report.window.requested_draft_limit}`);
  lines.push(`- newest_run_at: ${report.window.newest_run_at ?? 'none'}`);
  lines.push(`- oldest_run_at: ${report.window.oldest_run_at ?? 'none'}`);
  lines.push('');
  lines.push('Life State');
  lines.push(`- verification: ${lifeStateVerification.level ?? 'unknown'}/${lifeStateVerification.pass ? 'yes' : 'no'}`);
  lines.push(`- verification_errors: ${lifeStateVerification.error_count ?? 0}`);
  lines.push(`- verification_warnings: ${lifeStateVerification.warning_count ?? 0}`);
  lines.push(`- write_policy_error_count: ${lifeStateVerification.write_policy_error_count ?? 0}`);
  lines.push(`- unsafe_allowed_write_type_count: ${lifeStateVerification.unsafe_allowed_write_type_count ?? 0}`);
  lines.push(`- writes_enabled_count: ${lifeStateVerification.writes_enabled_count ?? 0}`);
  lines.push(`- rate_limit_error_count: ${lifeStateVerification.rate_limit_error_count ?? 0}`);
  lines.push(`- botland_identity_error_count: ${lifeStateVerification.botland_identity_error_count ?? 0}`);
  lines.push('');
  lines.push('Daemon');
  lines.push(`- run_count: ${daemon.run_count ?? 0}`);
  lines.push(`- last_run_id: ${daemon.last_run_id ?? 'none'}`);
  lines.push(`- last_seen_event_id: ${daemon.last_seen_event_id ?? 'none'}`);
  lines.push(`- processed_event_count: ${daemon.processed_event_count ?? 0}`);
  lines.push(`- verification: ${daemonVerification.level ?? 'unknown'}/${daemonVerification.pass ? 'yes' : 'no'}`);
  lines.push(`- verification_errors: ${daemonVerification.error_count ?? 0}`);
  lines.push(`- verification_warnings: ${daemonVerification.warning_count ?? 0}`);
  lines.push(`- last_run_missing_count: ${daemonVerification.last_run_missing_count ?? 0}`);
  lines.push(`- last_run_not_latest_count: ${daemonVerification.last_run_not_latest_count ?? 0}`);
  lines.push(`- run_reference_error_count: ${daemonVerification.run_reference_error_count ?? 0}`);
  lines.push(`- processed_event_duplicate_count: ${daemonVerification.processed_event_duplicate_count ?? 0}`);
  lines.push('');
  lines.push('Artifact Inventory');
  lines.push(`- verification: ${artifactInventory.level ?? 'unknown'}/${artifactInventory.pass ? 'yes' : 'no'}`);
  lines.push(`- verification_errors: ${artifactInventory.error_count ?? 0}`);
  lines.push(`- verification_warnings: ${artifactInventory.warning_count ?? 0}`);
  lines.push(`- unknown_runtime_file_count: ${artifactInventory.unknown_runtime_file_count ?? 0}`);
  lines.push(`- unknown_runtime_dir_count: ${artifactInventory.unknown_runtime_dir_count ?? 0}`);
  lines.push(`- non_json_artifact_file_count: ${artifactInventory.non_json_artifact_file_count ?? 0}`);
  lines.push(`- unexpected_subdir_count: ${artifactInventory.unexpected_subdir_count ?? 0}`);
  lines.push(`- json_parse_error_count: ${artifactInventory.json_parse_error_count ?? 0}`);
  lines.push(`- required_missing_count: ${artifactInventory.required_missing_count ?? 0}`);
  lines.push('');
  lines.push('Runtime Storage');
  lines.push(`- verification: ${runtimeStorage.level ?? 'unknown'}/${runtimeStorage.pass ? 'yes' : 'no'}`);
  lines.push(`- verification_errors: ${runtimeStorage.error_count ?? 0}`);
  lines.push(`- verification_warnings: ${runtimeStorage.warning_count ?? 0}`);
  lines.push(`- disk_available_mb: ${runtimeStorage.disk_available_mb ?? 'unknown'}`);
  lines.push(`- disk_available_percent: ${runtimeStorage.disk_available_percent ?? 'unknown'}`);
  lines.push(`- runtime_total_mb: ${runtimeStorage.runtime_total_mb ?? 'unknown'}`);
  lines.push(`- runtime_file_count: ${runtimeStorage.runtime_file_count ?? 0}`);
  lines.push(`- disk_free_error_count: ${runtimeStorage.disk_free_error_count ?? 0}`);
  lines.push(`- oversized_file_count: ${runtimeStorage.oversized_file_count ?? 0}`);
  lines.push(`- runtime_size_warning_count: ${runtimeStorage.runtime_size_warning_count ?? 0}`);
  lines.push('');
  lines.push('Systemd');
  lines.push(`- unit_verification: ${systemdUnitVerification.level ?? 'unknown'}/${systemdUnitVerification.pass ? 'yes' : 'no'}`);
  lines.push(`- unit_verification_errors: ${systemdUnitVerification.error_count ?? 0}`);
  lines.push(`- unit_preflight_gate_errors: ${systemdUnitVerification.preflight_gate_error_count ?? 0}`);
  lines.push(`- unit_runner_safety_errors: ${systemdUnitVerification.runner_safety_error_count ?? 0}`);
  lines.push(`- unit_timer_schedule_errors: ${systemdUnitVerification.timer_schedule_error_count ?? 0}`);
  lines.push(`- runtime_verification: ${systemdRuntimeVerification.level ?? 'unknown'}/${systemdRuntimeVerification.pass ? 'yes' : 'no'}`);
  lines.push(`- runtime_verification_errors: ${systemdRuntimeVerification.error_count ?? 0}`);
  lines.push(`- runtime_failed_services: ${systemdRuntimeVerification.failed_service_count ?? 0}`);
  lines.push(`- runtime_failed_timers: ${systemdRuntimeVerification.failed_timer_count ?? 0}`);
  lines.push(`- runtime_inactive_timers: ${systemdRuntimeVerification.inactive_timer_count ?? 0}`);
  lines.push(`- runtime_disabled_timers: ${systemdRuntimeVerification.disabled_timer_count ?? 0}`);
  lines.push('');
  lines.push('Runs');
  lines.push(`- latest_run: ${runAudit.latest_run?.run_id ?? 'none'}`);
  lines.push(`- run_verification: ${runAudit.verification?.level ?? 'unknown'}/${runAudit.verification?.pass ? 'yes' : 'no'}`);
  lines.push(`- run_verification_errors: ${runAudit.verification?.error_count ?? 0}`);
  lines.push(`- run_path_mismatch_count: ${runAudit.verification?.run_path_mismatch_count ?? 0}`);
  lines.push(`- run_external_action_count: ${runAudit.verification?.external_action_run_count ?? 0}`);
  lines.push(`- run_draft_safety_error_count: ${runAudit.verification?.draft_safety_error_count ?? 0}`);
  lines.push(`- external_action_count: ${runAudit.external_action_count}`);
  lines.push(`- runs_with_external_actions: ${runAudit.runs_with_external_actions.length}`);
  lines.push(`- failed_botland_run_count: ${runAudit.failed_botland_run_count}`);
  lines.push(`- identity_attention_run_count: ${runAudit.identity_attention_run_count}`);
  lines.push(`- draft_count: ${runAudit.draft_count}`);
  lines.push(`- ready_draft_count: ${runAudit.ready_draft_count}`);
  lines.push('');
  lines.push('Actions');
  lines.push(`- action_count: ${actionAudit.action_count}`);
  lines.push(`- approved_count: ${actionAudit.approved_count}`);
  lines.push(`- dismissed_count: ${actionAudit.dismissed_count}`);
  lines.push(`- dry_run_action_count: ${actionAudit.dry_run_action_count}`);
  lines.push(`- successful_send_count: ${actionAudit.successful_send_count}`);
  lines.push(`- inspected_successful_send_count: ${actionAudit.inspected_successful_send_count}`);
  lines.push(`- uninspected_successful_send_count: ${actionAudit.uninspected_successful_send_count}`);
  lines.push(`- successful_send_inspection_count: ${actionAudit.successful_send_inspection_count}`);
  lines.push(`- failed_send_count: ${actionAudit.failed_send_count}`);
  lines.push(`- external_write_action_count: ${actionAudit.external_write_action_count}`);
  lines.push('');
  lines.push('Drafts');
  lines.push(`- total: ${draftAudit.counts.total}`);
  lines.push(`- pending: ${draftAudit.counts.pending}`);
  lines.push(`- approved: ${draftAudit.counts.approved}`);
  lines.push(`- dismissed: ${draftAudit.counts.dismissed}`);
  lines.push(`- sent: ${draftAudit.counts.sent}`);
  lines.push(`- send_failed: ${draftAudit.counts.send_failed}`);
  lines.push(`- applied_dry_run: ${draftAudit.counts.applied_dry_run}`);
  lines.push('');
  lines.push('Checkpoints');
  lines.push(`- checkpoint_count: ${checkpointAudit.checkpoint_count}`);
  lines.push(`- checkpoint_path_mismatch_count: ${checkpointAudit.checkpoint_path_mismatch_count}`);
  lines.push(`- latest_checkpoint: ${checkpointAudit.latest_checkpoint_id ?? 'none'}`);
  lines.push(`- latest_generated_at: ${checkpointAudit.latest_generated_at ?? 'none'}`);
  lines.push(`- newest_two_change_count: ${checkpointAudit.newest_two_change_count ?? 'n/a'}`);
  lines.push(`- checkpoint_external_evidence_count: ${checkpointAudit.checkpoint_external_evidence_count}`);
  lines.push(`- checkpoint_failed_audit_count: ${checkpointAudit.checkpoint_failed_audit_count}`);
  lines.push(`- checkpoint_action_verification_failure_count: ${checkpointAudit.checkpoint_action_verification_failure_count}`);
  lines.push(`- summary_external_actions: ${checkpointAudit.summary_totals.external_action_count_in_window}`);
  lines.push(`- summary_successful_sends: ${checkpointAudit.summary_totals.successful_send_count}`);
  lines.push(`- summary_inspected_successful_sends: ${checkpointAudit.summary_totals.inspected_successful_send_count}`);
  lines.push(`- summary_uninspected_successful_sends: ${checkpointAudit.summary_totals.uninspected_successful_send_count}`);
  lines.push(`- summary_successful_send_inspections: ${checkpointAudit.summary_totals.successful_send_inspection_count}`);
  lines.push(`- summary_external_write_actions: ${checkpointAudit.summary_totals.external_write_action_count}`);
  lines.push(`- summary_action_verification_errors: ${checkpointAudit.summary_totals.action_verification_error_count}`);
  lines.push(`- summary_life_state_verification_errors: ${checkpointAudit.summary_totals.life_state_verification_error_count}`);
  lines.push(`- summary_life_state_write_policy_errors: ${checkpointAudit.summary_totals.life_state_write_policy_error_count}`);
  lines.push(`- summary_life_state_unsafe_allowed_writes: ${checkpointAudit.summary_totals.life_state_unsafe_allowed_write_type_count}`);
  lines.push(`- summary_life_state_writes_enabled: ${checkpointAudit.summary_totals.life_state_writes_enabled_count}`);
  lines.push(`- summary_life_state_rate_limit_errors: ${checkpointAudit.summary_totals.life_state_rate_limit_error_count}`);
  lines.push(`- summary_life_state_unattended_policy_errors: ${checkpointAudit.summary_totals.life_state_unattended_policy_error_count}`);
  lines.push(`- summary_life_state_unattended_policy_enabled: ${checkpointAudit.summary_totals.life_state_unattended_policy_enabled_count}`);
  lines.push(`- summary_life_state_identity_errors: ${checkpointAudit.summary_totals.life_state_botland_identity_error_count}`);
  lines.push(`- summary_action_preflight_gate_missing: ${checkpointAudit.summary_totals.action_preflight_gate_missing_count}`);
  lines.push(`- summary_action_preflight_gate_failed: ${checkpointAudit.summary_totals.action_preflight_gate_failed_count}`);
  lines.push(`- summary_action_preflight_gate_stale: ${checkpointAudit.summary_totals.action_preflight_gate_stale_count}`);
  lines.push(`- summary_action_path_mismatches: ${checkpointAudit.summary_totals.action_path_mismatch_count}`);
  lines.push(`- summary_action_draft_reference_errors: ${checkpointAudit.summary_totals.action_draft_reference_error_count}`);
  lines.push(`- summary_action_draft_hash_mismatches: ${checkpointAudit.summary_totals.action_draft_text_hash_mismatch_count}`);
  lines.push(`- summary_run_verification_errors: ${checkpointAudit.summary_totals.run_verification_error_count}`);
  lines.push(`- summary_run_path_mismatches: ${checkpointAudit.summary_totals.run_path_mismatch_count}`);
  lines.push(`- summary_run_external_actions: ${checkpointAudit.summary_totals.run_external_action_count}`);
  lines.push(`- summary_run_draft_safety_errors: ${checkpointAudit.summary_totals.run_draft_safety_error_count}`);
  lines.push(`- summary_daemon_state_verification_errors: ${checkpointAudit.summary_totals.daemon_state_verification_error_count}`);
  lines.push(`- summary_daemon_state_run_reference_errors: ${checkpointAudit.summary_totals.daemon_state_run_reference_error_count}`);
  lines.push(`- summary_daemon_state_event_duplicates: ${checkpointAudit.summary_totals.daemon_state_processed_event_duplicate_count}`);
  lines.push(`- summary_artifact_inventory_errors: ${checkpointAudit.summary_totals.artifact_inventory_error_count}`);
  lines.push(`- summary_artifact_unknown_files: ${checkpointAudit.summary_totals.artifact_unknown_file_count}`);
  lines.push(`- summary_artifact_unknown_dirs: ${checkpointAudit.summary_totals.artifact_unknown_dir_count}`);
  lines.push(`- summary_artifact_non_json_files: ${checkpointAudit.summary_totals.artifact_non_json_file_count}`);
  lines.push(`- summary_artifact_json_parse_errors: ${checkpointAudit.summary_totals.artifact_json_parse_error_count}`);
  lines.push(`- summary_runtime_storage_errors: ${checkpointAudit.summary_totals.runtime_storage_verification_error_count ?? 0}`);
  lines.push(`- summary_runtime_storage_disk_free_errors: ${checkpointAudit.summary_totals.runtime_storage_disk_free_error_count ?? 0}`);
  lines.push(`- summary_runtime_storage_oversized_files: ${checkpointAudit.summary_totals.runtime_storage_oversized_file_count ?? 0}`);
  lines.push(`- summary_systemd_unit_errors: ${checkpointAudit.summary_totals.systemd_unit_verification_error_count}`);
  lines.push(`- summary_systemd_unit_preflight_gate_errors: ${checkpointAudit.summary_totals.systemd_unit_preflight_gate_error_count}`);
  lines.push(`- summary_systemd_runtime_errors: ${checkpointAudit.summary_totals.systemd_runtime_verification_error_count}`);
  lines.push(`- summary_systemd_runtime_failed_services: ${checkpointAudit.summary_totals.systemd_runtime_failed_service_count}`);
  lines.push(`- summary_systemd_runtime_failed_timers: ${checkpointAudit.summary_totals.systemd_runtime_failed_timer_count}`);
  lines.push(`- summary_systemd_runtime_inactive_timers: ${checkpointAudit.summary_totals.systemd_runtime_inactive_timer_count}`);

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
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
