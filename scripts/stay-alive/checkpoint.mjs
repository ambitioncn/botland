#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 50,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    checkpointDir: null,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
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

  if (!args.checkpointDir) {
    args.checkpointDir = path.join(args.runtimeRoot, args.agent, 'checkpoints');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/checkpoint.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --limit <n>              Recent run window. Default: 50
  --runtime-root <dir>     Runtime agents directory.
  --checkpoint-dir <dir>   Directory for checkpoint artifacts.
  --json                   Print JSON summary instead of checkpoint text.
  --help                   Show this help.

This command creates a local checkpoint artifact from read-only status, operator,
and audit views. It never approves drafts, dismisses drafts, or sends BotLand
messages.
`);
}

function runtimeRootArgs(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function runJson(script, scriptArgs, options = {}) {
  const result = spawnSync(process.execPath, [
    script,
    ...scriptArgs,
    ...(options.addJsonFlag ? ['--json'] : [])
  ], {
    cwd: WORKSPACE,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `Command failed: ${script}`;
    throw new Error(message);
  }

  return JSON.parse(result.stdout);
}

function stampForFilename(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function summarize(
  status,
  operator,
  audit,
  controlAudit,
  lifeStateVerification,
  actionVerification,
  draftStateVerification,
  runVerification,
  daemonStateVerification,
  artifactInventory,
  runtimeStorageVerification,
  systemdUnitVerification,
  systemdRuntimeVerification,
  botlandBridgeVerification
) {
  const health = status.health ?? {};
  const control = status.control_state ?? {};
  const decision = operator.operator_decision ?? {};
  const verdict = audit.verdict ?? {};
  const actionAudit = audit.action_audit ?? {};
  const draftCounts = audit.draft_audit?.counts ?? {};
  const runAudit = audit.run_audit ?? {};

  return {
    health_ok: Boolean(health.ok),
    control_audit_pass: controlAudit?.pass === true,
    control_audit_level: controlAudit?.level ?? null,
    control_audit_error_count: controlAudit?.errors?.length ?? 0,
    control_audit_warning_count: controlAudit?.warnings?.length ?? 0,
    life_state_verification_pass: lifeStateVerification?.pass === true,
    life_state_verification_level: lifeStateVerification?.level ?? null,
    life_state_verification_error_count: lifeStateVerification?.error_count ?? 0,
    life_state_verification_warning_count: lifeStateVerification?.warning_count ?? 0,
    life_state_write_policy_error_count: lifeStateVerification?.write_policy_error_count ?? 0,
    life_state_unsafe_allowed_write_type_count: lifeStateVerification?.unsafe_allowed_write_type_count ?? 0,
    life_state_writes_enabled_count: lifeStateVerification?.writes_enabled_count ?? 0,
    life_state_rate_limit_error_count: lifeStateVerification?.rate_limit_error_count ?? 0,
    life_state_unattended_policy_error_count: lifeStateVerification?.unattended_policy_error_count ?? 0,
    life_state_unattended_policy_enabled_count: lifeStateVerification?.unattended_policy_enabled_count ?? 0,
    life_state_botland_identity_error_count: lifeStateVerification?.botland_identity_error_count ?? 0,
    action_verification_pass: actionVerification?.pass === true,
    action_verification_level: actionVerification?.level ?? null,
    action_verification_error_count: actionVerification?.error_count ?? 0,
    action_verification_warning_count: actionVerification?.warning_count ?? 0,
    action_preflight_gate_missing_count: actionVerification?.preflight_gate_missing_count ?? 0,
    action_preflight_gate_failed_count: actionVerification?.preflight_gate_failed_count ?? 0,
    action_preflight_gate_stale_count: actionVerification?.preflight_gate_stale_count ?? 0,
    action_path_mismatch_count: actionVerification?.action_path_mismatch_count ?? 0,
    action_draft_reference_error_count: actionVerification?.draft_reference_error_count ?? 0,
    action_draft_text_hash_mismatch_count: actionVerification?.draft_text_hash_mismatch_count ?? 0,
    draft_state_verification_pass: draftStateVerification?.pass === true,
    draft_state_verification_level: draftStateVerification?.level ?? null,
    draft_state_verification_error_count: draftStateVerification?.error_count ?? 0,
    draft_state_verification_warning_count: draftStateVerification?.warning_count ?? 0,
    draft_state_conflict_error_count: draftStateVerification?.conflict_error_count ?? 0,
    draft_state_approved_hash_mismatch_count: draftStateVerification?.approved_hash_mismatch_count ?? 0,
    draft_state_ready_safety_error_count: draftStateVerification?.ready_draft_safety_error_count ?? 0,
    draft_state_approved_queue_overflow_count: draftStateVerification?.approved_queue_overflow_count ?? 0,
    run_verification_pass: runVerification?.pass === true,
    run_verification_level: runVerification?.level ?? null,
    run_verification_error_count: runVerification?.error_count ?? 0,
    run_verification_warning_count: runVerification?.warning_count ?? 0,
    run_path_mismatch_count: runVerification?.run_path_mismatch_count ?? 0,
    run_external_action_count: runVerification?.external_action_run_count ?? 0,
    run_draft_safety_error_count: runVerification?.draft_safety_error_count ?? 0,
    daemon_state_verification_pass: daemonStateVerification?.pass === true,
    daemon_state_verification_level: daemonStateVerification?.level ?? null,
    daemon_state_verification_error_count: daemonStateVerification?.error_count ?? 0,
    daemon_state_verification_warning_count: daemonStateVerification?.warning_count ?? 0,
    daemon_state_last_run_missing_count: daemonStateVerification?.last_run_missing_count ?? 0,
    daemon_state_run_reference_error_count: daemonStateVerification?.run_reference_error_count ?? 0,
    daemon_state_processed_event_duplicate_count: daemonStateVerification?.processed_event_duplicate_count ?? 0,
    artifact_inventory_pass: artifactInventory?.pass === true,
    artifact_inventory_level: artifactInventory?.level ?? null,
    artifact_inventory_error_count: artifactInventory?.error_count ?? 0,
    artifact_inventory_warning_count: artifactInventory?.warning_count ?? 0,
    artifact_unknown_file_count: artifactInventory?.unknown_runtime_file_count ?? 0,
    artifact_unknown_dir_count: artifactInventory?.unknown_runtime_dir_count ?? 0,
    artifact_non_json_file_count: artifactInventory?.non_json_artifact_file_count ?? 0,
    artifact_unexpected_subdir_count: artifactInventory?.unexpected_subdir_count ?? 0,
    artifact_json_parse_error_count: artifactInventory?.json_parse_error_count ?? 0,
    artifact_required_missing_count: artifactInventory?.required_missing_count ?? 0,
    runtime_storage_verification_pass: runtimeStorageVerification?.pass === true,
    runtime_storage_verification_level: runtimeStorageVerification?.level ?? null,
    runtime_storage_verification_error_count: runtimeStorageVerification?.error_count ?? 0,
    runtime_storage_verification_warning_count: runtimeStorageVerification?.warning_count ?? 0,
    runtime_storage_disk_available_mb: runtimeStorageVerification?.disk?.available_mb ?? null,
    runtime_storage_disk_available_percent: runtimeStorageVerification?.disk?.available_percent ?? null,
    runtime_storage_total_mb: runtimeStorageVerification?.runtime?.total_mb ?? null,
    runtime_storage_file_count: runtimeStorageVerification?.runtime?.file_count ?? 0,
    runtime_storage_disk_free_error_count: runtimeStorageVerification?.disk_free_error_count ?? 0,
    runtime_storage_oversized_file_count: runtimeStorageVerification?.oversized_file_count ?? 0,
    runtime_storage_size_warning_count: runtimeStorageVerification?.runtime_size_warning_count ?? 0,
    systemd_unit_verification_pass: systemdUnitVerification?.pass === true,
    systemd_unit_verification_level: systemdUnitVerification?.level ?? null,
    systemd_unit_verification_error_count: systemdUnitVerification?.error_count ?? 0,
    systemd_unit_verification_warning_count: systemdUnitVerification?.warning_count ?? 0,
    systemd_unit_missing_service_count: systemdUnitVerification?.missing_service_count ?? 0,
    systemd_unit_missing_timer_count: systemdUnitVerification?.missing_timer_count ?? 0,
    systemd_unit_preflight_gate_error_count: systemdUnitVerification?.preflight_gate_error_count ?? 0,
    systemd_unit_runner_safety_error_count: systemdUnitVerification?.runner_safety_error_count ?? 0,
    systemd_unit_timer_schedule_error_count: systemdUnitVerification?.timer_schedule_error_count ?? 0,
    systemd_runtime_verification_pass: systemdRuntimeVerification?.pass === true,
    systemd_runtime_verification_level: systemdRuntimeVerification?.level ?? null,
    systemd_runtime_verification_error_count: systemdRuntimeVerification?.error_count ?? 0,
    systemd_runtime_verification_warning_count: systemdRuntimeVerification?.warning_count ?? 0,
    systemd_runtime_missing_service_count: systemdRuntimeVerification?.missing_service_count ?? 0,
    systemd_runtime_missing_timer_count: systemdRuntimeVerification?.missing_timer_count ?? 0,
    systemd_runtime_failed_service_count: systemdRuntimeVerification?.failed_service_count ?? 0,
    systemd_runtime_uninspected_failed_service_count: systemdRuntimeVerification?.uninspected_failed_service_count ?? 0,
    systemd_runtime_inspected_failed_service_count: systemdRuntimeVerification?.inspected_failed_service_count ?? 0,
    service_failure_inspection_count: systemdRuntimeVerification?.service_failure_inspection_count ?? 0,
    service_failure_recovery_count: systemdRuntimeVerification?.service_failure_recovery_count ?? 0,
    systemd_runtime_failed_timer_count: systemdRuntimeVerification?.failed_timer_count ?? 0,
    systemd_runtime_inactive_timer_count: systemdRuntimeVerification?.inactive_timer_count ?? 0,
    systemd_runtime_disabled_timer_count: systemdRuntimeVerification?.disabled_timer_count ?? 0,
    botland_bridge_verification_pass: botlandBridgeVerification?.pass === true,
    botland_bridge_verification_level: botlandBridgeVerification?.level ?? null,
    botland_bridge_verification_error_count: botlandBridgeVerification?.error_count ?? 0,
    botland_bridge_verification_warning_count: botlandBridgeVerification?.warning_count ?? 0,
    botland_bridge_identity_mismatch_count: botlandBridgeVerification?.identity_mismatch_count ?? 0,
    botland_bridge_cli_version_error_count: botlandBridgeVerification?.cli_version_error_count ?? 0,
    botland_bridge_daemon_health_error_count: botlandBridgeVerification?.daemon_health_error_count ?? 0,
    botland_bridge_websocket_disconnected_count: botlandBridgeVerification?.websocket_disconnected_count ?? 0,
    operator_paused: control.paused === true,
    operator_paused_raw: control.paused_raw === true,
    pause_reason: control.pause_reason ?? null,
    pause_until: control.pause_until ?? null,
    pause_expired: control.pause_expired === true,
    latest_run_id: status.latest_run?.run_id ?? null,
    latest_run_needs_attention: Boolean(health.latest_run_needs_attention),
    operator_decision: decision.level ?? null,
    audit_verdict: verdict.level ?? null,
    audit_pass: Boolean(verdict.pass),
    pending_draft_count: health.pending_draft_count ?? draftCounts.pending ?? 0,
    approved_draft_count: health.approved_draft_count ?? draftCounts.approved ?? 0,
    visible_draft_count: health.visible_draft_count ?? 0,
    external_action_count_in_window: health.external_action_count_in_window ?? runAudit.external_action_count ?? 0,
    successful_send_count: actionAudit.successful_send_count ?? 0,
    inspected_successful_send_count: actionAudit.inspected_successful_send_count ?? 0,
    uninspected_successful_send_count: actionAudit.uninspected_successful_send_count ?? 0,
    successful_send_inspection_count: actionAudit.successful_send_inspection_count ?? 0,
    external_write_action_count: actionAudit.external_write_action_count ?? 0
  };
}

function buildCheckpoint(args) {
  const commonArgs = [
    '--agent',
    args.agent,
    '--limit',
    String(args.limit),
    ...runtimeRootArgs(args)
  ];
  const generatedAt = new Date();

  const status = runJson('scripts/stay-alive/status.mjs', commonArgs);
  const operator = runJson('scripts/stay-alive/operator-console.mjs', commonArgs, { addJsonFlag: true });
  const audit = runJson('scripts/stay-alive/audit-report.mjs', commonArgs, { addJsonFlag: true });
  const controlAudit = runJson('scripts/stay-alive/control-audit.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const lifeStateVerification = runJson('scripts/stay-alive/life-state-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const actionVerification = runJson('scripts/stay-alive/action-verify.mjs', [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const draftStateVerification = runJson('scripts/stay-alive/draft-state-verify.mjs', [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const runVerification = runJson('scripts/stay-alive/run-verify.mjs', [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const daemonStateVerification = runJson('scripts/stay-alive/daemon-state-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const artifactInventory = runJson('scripts/stay-alive/artifact-inventory.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const runtimeStorageVerification = runJson('scripts/stay-alive/runtime-storage-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const systemdUnitVerification = runJson('scripts/stay-alive/systemd-unit-verify.mjs', [
    '--agent',
    args.agent,
    '--workspace',
    WORKSPACE
  ], { addJsonFlag: true });
  const systemdRuntimeVerification = runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const botlandBridgeVerification = runJson('scripts/stay-alive/botland-bridge-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args)
  ], { addJsonFlag: true });
  const summary = summarize(
    status,
    operator,
    audit,
    controlAudit,
    lifeStateVerification,
    actionVerification,
    draftStateVerification,
    runVerification,
    daemonStateVerification,
    artifactInventory,
    runtimeStorageVerification,
    systemdUnitVerification,
    systemdRuntimeVerification,
    botlandBridgeVerification
  );
  const checkpointId = `stay_alive_checkpoint_${stampForFilename(generatedAt)}_${args.agent}`;
  const checkpointPath = path.join(args.checkpointDir, `${checkpointId}.json`);

  const checkpoint = {
    checkpoint_id: checkpointId,
    generated_at: generatedAt.toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    limit: args.limit,
    local_only: true,
    external_write: false,
    summary,
    status,
    operator_console: operator,
    audit_report: audit,
    control_audit: controlAudit,
    life_state_verification: lifeStateVerification,
    action_verification: actionVerification,
    draft_state_verification: draftStateVerification,
    run_verification: runVerification,
    daemon_state_verification: daemonStateVerification,
    artifact_inventory: artifactInventory,
    runtime_storage_verification: runtimeStorageVerification,
    systemd_unit_verification: systemdUnitVerification,
    systemd_runtime_verification: systemdRuntimeVerification,
    botland_bridge_verification: botlandBridgeVerification
  };

  mkdirSync(args.checkpointDir, { recursive: true });
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  return {
    ...checkpoint,
    checkpoint_path: path.relative(WORKSPACE, checkpointPath)
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(checkpoint) {
  const summary = checkpoint.summary;
  const lines = [];

  lines.push(`Stay-Alive checkpoint (${checkpoint.agent_id})`);
  lines.push(`generated_at: ${checkpoint.generated_at}`);
  lines.push(`checkpoint_id: ${checkpoint.checkpoint_id}`);
  lines.push(`checkpoint_path: ${checkpoint.checkpoint_path}`);
  lines.push('');
  lines.push('Summary');
  lines.push(`- health_ok: ${boolLabel(summary.health_ok)}`);
  lines.push(`- control_audit_pass: ${boolLabel(summary.control_audit_pass)}`);
  lines.push(`- control_audit_level: ${summary.control_audit_level ?? 'unknown'}`);
  lines.push(`- control_audit_errors: ${summary.control_audit_error_count}`);
  lines.push(`- control_audit_warnings: ${summary.control_audit_warning_count}`);
  lines.push(`- life_state_verification_pass: ${boolLabel(summary.life_state_verification_pass)}`);
  lines.push(`- life_state_verification_level: ${summary.life_state_verification_level ?? 'unknown'}`);
  lines.push(`- life_state_verification_errors: ${summary.life_state_verification_error_count}`);
  lines.push(`- life_state_verification_warnings: ${summary.life_state_verification_warning_count}`);
  lines.push(`- life_state_write_policy_errors: ${summary.life_state_write_policy_error_count}`);
  lines.push(`- life_state_unsafe_allowed_writes: ${summary.life_state_unsafe_allowed_write_type_count}`);
  lines.push(`- life_state_writes_enabled: ${summary.life_state_writes_enabled_count}`);
  lines.push(`- life_state_rate_limit_errors: ${summary.life_state_rate_limit_error_count}`);
  lines.push(`- life_state_unattended_policy_errors: ${summary.life_state_unattended_policy_error_count}`);
  lines.push(`- life_state_unattended_policy_enabled: ${summary.life_state_unattended_policy_enabled_count}`);
  lines.push(`- life_state_botland_identity_errors: ${summary.life_state_botland_identity_error_count}`);
  lines.push(`- action_verification_pass: ${boolLabel(summary.action_verification_pass)}`);
  lines.push(`- action_verification_level: ${summary.action_verification_level ?? 'unknown'}`);
  lines.push(`- action_verification_errors: ${summary.action_verification_error_count}`);
  lines.push(`- action_verification_warnings: ${summary.action_verification_warning_count}`);
  lines.push(`- action_preflight_gate_missing: ${summary.action_preflight_gate_missing_count}`);
  lines.push(`- action_preflight_gate_failed: ${summary.action_preflight_gate_failed_count}`);
  lines.push(`- action_preflight_gate_stale: ${summary.action_preflight_gate_stale_count}`);
  lines.push(`- action_path_mismatches: ${summary.action_path_mismatch_count}`);
  lines.push(`- action_draft_reference_errors: ${summary.action_draft_reference_error_count}`);
  lines.push(`- action_draft_text_hash_mismatches: ${summary.action_draft_text_hash_mismatch_count}`);
  lines.push(`- draft_state_verification_pass: ${boolLabel(summary.draft_state_verification_pass)}`);
  lines.push(`- draft_state_verification_level: ${summary.draft_state_verification_level ?? 'unknown'}`);
  lines.push(`- draft_state_verification_errors: ${summary.draft_state_verification_error_count}`);
  lines.push(`- draft_state_verification_warnings: ${summary.draft_state_verification_warning_count}`);
  lines.push(`- draft_state_conflict_errors: ${summary.draft_state_conflict_error_count}`);
  lines.push(`- draft_state_approved_hash_mismatches: ${summary.draft_state_approved_hash_mismatch_count}`);
  lines.push(`- draft_state_ready_safety_errors: ${summary.draft_state_ready_safety_error_count}`);
  lines.push(`- draft_state_approved_queue_overflow: ${summary.draft_state_approved_queue_overflow_count}`);
  lines.push(`- run_verification_pass: ${boolLabel(summary.run_verification_pass)}`);
  lines.push(`- run_verification_level: ${summary.run_verification_level ?? 'unknown'}`);
  lines.push(`- run_verification_errors: ${summary.run_verification_error_count}`);
  lines.push(`- run_verification_warnings: ${summary.run_verification_warning_count}`);
  lines.push(`- run_path_mismatches: ${summary.run_path_mismatch_count}`);
  lines.push(`- run_external_actions: ${summary.run_external_action_count}`);
  lines.push(`- run_draft_safety_errors: ${summary.run_draft_safety_error_count}`);
  lines.push(`- daemon_state_verification_pass: ${boolLabel(summary.daemon_state_verification_pass)}`);
  lines.push(`- daemon_state_verification_level: ${summary.daemon_state_verification_level ?? 'unknown'}`);
  lines.push(`- daemon_state_verification_errors: ${summary.daemon_state_verification_error_count}`);
  lines.push(`- daemon_state_verification_warnings: ${summary.daemon_state_verification_warning_count}`);
  lines.push(`- daemon_state_last_run_missing: ${summary.daemon_state_last_run_missing_count}`);
  lines.push(`- daemon_state_run_reference_errors: ${summary.daemon_state_run_reference_error_count}`);
  lines.push(`- daemon_state_processed_event_duplicates: ${summary.daemon_state_processed_event_duplicate_count}`);
  lines.push(`- artifact_inventory_pass: ${boolLabel(summary.artifact_inventory_pass)}`);
  lines.push(`- artifact_inventory_level: ${summary.artifact_inventory_level ?? 'unknown'}`);
  lines.push(`- artifact_inventory_errors: ${summary.artifact_inventory_error_count}`);
  lines.push(`- artifact_inventory_warnings: ${summary.artifact_inventory_warning_count}`);
  lines.push(`- artifact_unknown_files: ${summary.artifact_unknown_file_count}`);
  lines.push(`- artifact_unknown_dirs: ${summary.artifact_unknown_dir_count}`);
  lines.push(`- artifact_non_json_files: ${summary.artifact_non_json_file_count}`);
  lines.push(`- artifact_unexpected_subdirs: ${summary.artifact_unexpected_subdir_count}`);
  lines.push(`- artifact_json_parse_errors: ${summary.artifact_json_parse_error_count}`);
  lines.push(`- artifact_required_missing: ${summary.artifact_required_missing_count}`);
  lines.push(`- runtime_storage_verification_pass: ${boolLabel(summary.runtime_storage_verification_pass)}`);
  lines.push(`- runtime_storage_verification_level: ${summary.runtime_storage_verification_level ?? 'unknown'}`);
  lines.push(`- runtime_storage_verification_errors: ${summary.runtime_storage_verification_error_count}`);
  lines.push(`- runtime_storage_verification_warnings: ${summary.runtime_storage_verification_warning_count}`);
  lines.push(`- runtime_storage_disk_available_mb: ${summary.runtime_storage_disk_available_mb ?? 'unknown'}`);
  lines.push(`- runtime_storage_disk_available_percent: ${summary.runtime_storage_disk_available_percent ?? 'unknown'}`);
  lines.push(`- runtime_storage_total_mb: ${summary.runtime_storage_total_mb ?? 'unknown'}`);
  lines.push(`- runtime_storage_file_count: ${summary.runtime_storage_file_count}`);
  lines.push(`- runtime_storage_disk_free_errors: ${summary.runtime_storage_disk_free_error_count}`);
  lines.push(`- runtime_storage_oversized_files: ${summary.runtime_storage_oversized_file_count}`);
  lines.push(`- runtime_storage_size_warnings: ${summary.runtime_storage_size_warning_count}`);
  lines.push(`- systemd_unit_verification_pass: ${boolLabel(summary.systemd_unit_verification_pass)}`);
  lines.push(`- systemd_unit_verification_level: ${summary.systemd_unit_verification_level ?? 'unknown'}`);
  lines.push(`- systemd_unit_verification_errors: ${summary.systemd_unit_verification_error_count}`);
  lines.push(`- systemd_unit_verification_warnings: ${summary.systemd_unit_verification_warning_count}`);
  lines.push(`- systemd_unit_missing_services: ${summary.systemd_unit_missing_service_count}`);
  lines.push(`- systemd_unit_missing_timers: ${summary.systemd_unit_missing_timer_count}`);
  lines.push(`- systemd_unit_preflight_gate_errors: ${summary.systemd_unit_preflight_gate_error_count}`);
  lines.push(`- systemd_unit_runner_safety_errors: ${summary.systemd_unit_runner_safety_error_count}`);
  lines.push(`- systemd_unit_timer_schedule_errors: ${summary.systemd_unit_timer_schedule_error_count}`);
  lines.push(`- systemd_runtime_verification_pass: ${boolLabel(summary.systemd_runtime_verification_pass)}`);
  lines.push(`- systemd_runtime_verification_level: ${summary.systemd_runtime_verification_level ?? 'unknown'}`);
  lines.push(`- systemd_runtime_verification_errors: ${summary.systemd_runtime_verification_error_count}`);
  lines.push(`- systemd_runtime_verification_warnings: ${summary.systemd_runtime_verification_warning_count}`);
  lines.push(`- systemd_runtime_missing_services: ${summary.systemd_runtime_missing_service_count}`);
  lines.push(`- systemd_runtime_missing_timers: ${summary.systemd_runtime_missing_timer_count}`);
  lines.push(`- systemd_runtime_failed_services: ${summary.systemd_runtime_failed_service_count}`);
  lines.push(`- systemd_runtime_failed_timers: ${summary.systemd_runtime_failed_timer_count}`);
  lines.push(`- systemd_runtime_inactive_timers: ${summary.systemd_runtime_inactive_timer_count}`);
  lines.push(`- systemd_runtime_disabled_timers: ${summary.systemd_runtime_disabled_timer_count}`);
  lines.push(`- botland_bridge_verification_pass: ${boolLabel(summary.botland_bridge_verification_pass)}`);
  lines.push(`- botland_bridge_verification_level: ${summary.botland_bridge_verification_level ?? 'unknown'}`);
  lines.push(`- botland_bridge_verification_errors: ${summary.botland_bridge_verification_error_count}`);
  lines.push(`- botland_bridge_verification_warnings: ${summary.botland_bridge_verification_warning_count}`);
  lines.push(`- botland_bridge_identity_mismatches: ${summary.botland_bridge_identity_mismatch_count}`);
  lines.push(`- botland_bridge_cli_version_errors: ${summary.botland_bridge_cli_version_error_count}`);
  lines.push(`- botland_bridge_daemon_health_errors: ${summary.botland_bridge_daemon_health_error_count}`);
  lines.push(`- botland_bridge_websocket_disconnected: ${summary.botland_bridge_websocket_disconnected_count}`);
  lines.push(`- operator_paused: ${boolLabel(summary.operator_paused)}`);
  lines.push(`- operator_paused_raw: ${boolLabel(summary.operator_paused_raw)}`);
  lines.push(`- pause_reason: ${summary.pause_reason ?? 'none'}`);
  lines.push(`- pause_until: ${summary.pause_until ?? 'none'}`);
  lines.push(`- pause_expired: ${boolLabel(summary.pause_expired)}`);
  lines.push(`- latest_run_id: ${summary.latest_run_id ?? 'none'}`);
  lines.push(`- latest_run_needs_attention: ${boolLabel(summary.latest_run_needs_attention)}`);
  lines.push(`- operator_decision: ${summary.operator_decision ?? 'unknown'}`);
  lines.push(`- audit_verdict: ${summary.audit_verdict ?? 'unknown'}`);
  lines.push(`- audit_pass: ${boolLabel(summary.audit_pass)}`);
  lines.push(`- pending_draft_count: ${summary.pending_draft_count}`);
  lines.push(`- approved_draft_count: ${summary.approved_draft_count}`);
  lines.push(`- visible_draft_count: ${summary.visible_draft_count}`);
  lines.push(`- external_action_count_in_window: ${summary.external_action_count_in_window}`);
  lines.push(`- successful_send_count: ${summary.successful_send_count}`);
  lines.push(`- inspected_successful_send_count: ${summary.inspected_successful_send_count}`);
  lines.push(`- uninspected_successful_send_count: ${summary.uninspected_successful_send_count}`);
  lines.push(`- successful_send_inspection_count: ${summary.successful_send_inspection_count}`);
  lines.push(`- external_write_action_count: ${summary.external_write_action_count}`);
  lines.push('');
  lines.push('Safety');
  lines.push('- local_only: yes');
  lines.push('- external_write: no');
  lines.push('- checkpoint_performed_approval_or_send: no');

  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const checkpoint = buildCheckpoint(args);
  if (args.format === 'json') {
    console.log(JSON.stringify({
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_path: checkpoint.checkpoint_path,
      generated_at: checkpoint.generated_at,
      agent_id: checkpoint.agent_id,
      summary: checkpoint.summary,
      local_only: checkpoint.local_only,
      external_write: checkpoint.external_write
    }, null, 2));
  } else {
    process.stdout.write(formatText(checkpoint));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
