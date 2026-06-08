#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

const REQUIRED_TOP_LEVEL_FIELDS = [
  'checkpoint_id',
  'generated_at',
  'agent_id',
  'runtime_root',
  'limit',
  'local_only',
  'external_write',
  'summary',
  'status',
  'operator_console',
  'audit_report'
];

const REQUIRED_SUMMARY_FIELDS = [
  'health_ok',
  'latest_run_id',
  'latest_run_needs_attention',
  'operator_decision',
  'audit_verdict',
  'audit_pass',
  'pending_draft_count',
  'approved_draft_count',
  'visible_draft_count',
  'external_action_count_in_window',
  'successful_send_count',
  'external_write_action_count'
];

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 100,
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
  console.log(`Usage: node scripts/stay-alive/checkpoint-verify.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --limit <n>              Number of checkpoints to verify. Default: 100
  --runtime-root <dir>     Runtime agents directory.
  --checkpoint-dir <dir>   Directory containing checkpoint artifacts.
  --json                   Print JSON instead of verification text.
  --help                   Show this help.

This command is read-only. It verifies checkpoint artifact structure and safety
invariants; it never creates checkpoints, approves drafts, dismisses drafts, or
sends BotLand messages.
`);
}

function listCheckpointFiles(checkpointDir, limit) {
  if (!existsSync(checkpointDir)) return [];

  return readdirSync(checkpointDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(checkpointDir, name);
      const stats = statSync(file);
      return { file, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))
    .slice(0, limit)
    .map((item) => item.file);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function numberValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function verifyCheckpointPath(file, checkpoint, issues) {
  if (typeof checkpoint.checkpoint_id !== 'string' || checkpoint.checkpoint_id.length === 0) {
    addIssue(issues, 'error', 'invalid_checkpoint_id', 'Checkpoint must have a non-empty checkpoint_id string');
    return;
  }

  const expectedFilename = `${checkpoint.checkpoint_id}.json`;
  const actualFilename = path.basename(file);
  if (actualFilename !== expectedFilename) {
    addIssue(
      issues,
      'error',
      'checkpoint_path_id_mismatch',
      `Checkpoint file must be named ${expectedFilename}, got ${actualFilename}`
    );
  }
}

function addIssue(target, severity, code, message) {
  target.push({ severity, code, message });
}

function verifyCheckpoint(file, expectedAgent) {
  const relativePath = path.relative(WORKSPACE, file);
  const issues = [];
  let checkpoint = null;

  try {
    checkpoint = readJson(file);
  } catch (error) {
    addIssue(issues, 'error', 'invalid_json', error instanceof Error ? error.message : String(error));
    return {
      checkpoint_id: path.basename(file, '.json'),
      checkpoint_path: relativePath,
      generated_at: null,
      agent_id: null,
      pass: false,
      issue_count: issues.length,
      error_count: issues.length,
      warning_count: 0,
      issues,
      summary: null
    };
  }

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!hasOwn(checkpoint, field)) {
      addIssue(issues, 'error', 'missing_top_level_field', `Missing top-level field: ${field}`);
    }
  }
  verifyCheckpointPath(file, checkpoint, issues);

  const summary = checkpoint.summary ?? {};
  for (const field of REQUIRED_SUMMARY_FIELDS) {
    if (!hasOwn(summary, field)) {
      addIssue(issues, 'error', 'missing_summary_field', `Missing summary field: ${field}`);
    }
  }

  if (checkpoint.agent_id !== expectedAgent) {
    addIssue(issues, 'error', 'agent_mismatch', `Expected agent ${expectedAgent}, got ${checkpoint.agent_id ?? 'null'}`);
  }
  if (checkpoint.local_only !== true) {
    addIssue(issues, 'error', 'not_local_only', 'Checkpoint must be marked local_only=true');
  }
  if (checkpoint.external_write !== false) {
    addIssue(issues, 'error', 'checkpoint_external_write', 'Checkpoint must be marked external_write=false');
  }
  if (checkpoint.operator_console?.read_only !== true) {
    addIssue(issues, 'error', 'operator_not_read_only', 'Embedded operator console must be read_only=true');
  }
  if (checkpoint.audit_report?.read_only !== true) {
    addIssue(issues, 'error', 'audit_not_read_only', 'Embedded audit report must be read_only=true');
  }
  if (checkpoint.control_audit) {
    if (checkpoint.control_audit.read_only !== true) {
      addIssue(issues, 'error', 'control_audit_not_read_only', 'Embedded control audit must be read_only=true');
    }
    if (checkpoint.control_audit.local_only !== true) {
      addIssue(issues, 'error', 'control_audit_not_local_only', 'Embedded control audit must be local_only=true');
    }
    if (checkpoint.control_audit.external_write !== false) {
      addIssue(issues, 'error', 'control_audit_external_write', 'Embedded control audit must be external_write=false');
    }
    if (checkpoint.control_audit.botland_send !== false) {
      addIssue(issues, 'error', 'control_audit_botland_send', 'Embedded control audit must be botland_send=false');
    }
    if (checkpoint.control_audit.pass !== true) {
      addIssue(issues, 'error', 'control_audit_not_pass', 'Embedded control audit must pass');
    }
  }
  if (checkpoint.life_state_verification) {
    if (checkpoint.life_state_verification.read_only !== true) {
      addIssue(issues, 'error', 'life_state_verification_not_read_only', 'Embedded life state verification must be read_only=true');
    }
    if (checkpoint.life_state_verification.pass !== true) {
      addIssue(issues, 'error', 'life_state_verification_not_pass', 'Embedded life state verification must pass');
    }
    if ((checkpoint.life_state_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'life_state_verification_errors',
        `Embedded life state verification has error_count=${checkpoint.life_state_verification.error_count}`
      );
    }
    if ((checkpoint.life_state_verification.write_policy_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'life_state_write_policy_errors',
        `Embedded life state verification has write_policy_error_count=${checkpoint.life_state_verification.write_policy_error_count}`
      );
    }
    if ((checkpoint.life_state_verification.unsafe_allowed_write_type_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'life_state_unsafe_allowed_writes',
        `Embedded life state verification has unsafe_allowed_write_type_count=${checkpoint.life_state_verification.unsafe_allowed_write_type_count}`
      );
    }
  }
  if (checkpoint.action_verification) {
    if (checkpoint.action_verification.read_only !== true) {
      addIssue(issues, 'error', 'action_verification_not_read_only', 'Embedded action verification must be read_only=true');
    }
    if (checkpoint.action_verification.pass !== true) {
      addIssue(issues, 'error', 'action_verification_not_pass', 'Embedded action verification must pass');
    }
    if ((checkpoint.action_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'action_verification_errors',
        `Embedded action verification has error_count=${checkpoint.action_verification.error_count}`
      );
    }
    if ((checkpoint.action_verification.uninspected_successful_send_count ?? checkpoint.action_verification.successful_send_action_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'action_verification_uninspected_successful_send',
        `Embedded action verification has uninspected_successful_send_count=${checkpoint.action_verification.uninspected_successful_send_count ?? checkpoint.action_verification.successful_send_action_count}`
      );
    }
    if ((checkpoint.action_verification.external_write_action_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'action_verification_external_write',
        `Embedded action verification has external_write_action_count=${checkpoint.action_verification.external_write_action_count}`
      );
    }
    if ((checkpoint.action_verification.draft_reference_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'action_verification_draft_reference_errors',
        `Embedded action verification has draft_reference_error_count=${checkpoint.action_verification.draft_reference_error_count}`
      );
    }
    if ((checkpoint.action_verification.preflight_gate_stale_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'action_verification_stale_preflight_gate',
        `Embedded action verification has preflight_gate_stale_count=${checkpoint.action_verification.preflight_gate_stale_count}`
      );
    }
    if ((checkpoint.action_verification.action_path_mismatch_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'action_verification_path_mismatch',
        `Embedded action verification has action_path_mismatch_count=${checkpoint.action_verification.action_path_mismatch_count}`
      );
    }
    if ((checkpoint.action_verification.draft_text_hash_mismatch_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'action_verification_draft_hash_mismatch',
        `Embedded action verification has draft_text_hash_mismatch_count=${checkpoint.action_verification.draft_text_hash_mismatch_count}`
      );
    }
  }
  if (checkpoint.draft_state_verification) {
    if (checkpoint.draft_state_verification.read_only !== true) {
      addIssue(issues, 'error', 'draft_state_verification_not_read_only', 'Embedded draft state verification must be read_only=true');
    }
    if (checkpoint.draft_state_verification.pass !== true) {
      addIssue(issues, 'error', 'draft_state_verification_not_pass', 'Embedded draft state verification must pass');
    }
    if ((checkpoint.draft_state_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'draft_state_verification_errors',
        `Embedded draft state verification has error_count=${checkpoint.draft_state_verification.error_count}`
      );
    }
    if ((checkpoint.draft_state_verification.conflict_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'draft_state_verification_conflicts',
        `Embedded draft state verification has conflict_error_count=${checkpoint.draft_state_verification.conflict_error_count}`
      );
    }
    if ((checkpoint.draft_state_verification.approved_hash_mismatch_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'draft_state_verification_hash_mismatch',
        `Embedded draft state verification has approved_hash_mismatch_count=${checkpoint.draft_state_verification.approved_hash_mismatch_count}`
      );
    }
    if ((checkpoint.draft_state_verification.ready_draft_safety_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'draft_state_verification_ready_safety',
        `Embedded draft state verification has ready_draft_safety_error_count=${checkpoint.draft_state_verification.ready_draft_safety_error_count}`
      );
    }
  }
  if (checkpoint.run_verification) {
    if (checkpoint.run_verification.read_only !== true) {
      addIssue(issues, 'error', 'run_verification_not_read_only', 'Embedded run verification must be read_only=true');
    }
    if (checkpoint.run_verification.pass !== true) {
      addIssue(issues, 'error', 'run_verification_not_pass', 'Embedded run verification must pass');
    }
    if ((checkpoint.run_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'run_verification_errors',
        `Embedded run verification has error_count=${checkpoint.run_verification.error_count}`
      );
    }
    if ((checkpoint.run_verification.run_path_mismatch_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'run_verification_path_mismatch',
        `Embedded run verification has run_path_mismatch_count=${checkpoint.run_verification.run_path_mismatch_count}`
      );
    }
    if ((checkpoint.run_verification.external_action_run_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'run_verification_external_actions',
        `Embedded run verification has external_action_run_count=${checkpoint.run_verification.external_action_run_count}`
      );
    }
    if ((checkpoint.run_verification.draft_safety_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'run_verification_draft_safety',
        `Embedded run verification has draft_safety_error_count=${checkpoint.run_verification.draft_safety_error_count}`
      );
    }
  }
  if (checkpoint.daemon_state_verification) {
    if (checkpoint.daemon_state_verification.read_only !== true) {
      addIssue(issues, 'error', 'daemon_state_verification_not_read_only', 'Embedded daemon state verification must be read_only=true');
    }
    if (checkpoint.daemon_state_verification.pass !== true) {
      addIssue(issues, 'error', 'daemon_state_verification_not_pass', 'Embedded daemon state verification must pass');
    }
    if ((checkpoint.daemon_state_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'daemon_state_verification_errors',
        `Embedded daemon state verification has error_count=${checkpoint.daemon_state_verification.error_count}`
      );
    }
    if ((checkpoint.daemon_state_verification.run_reference_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'daemon_state_verification_run_reference_errors',
        `Embedded daemon state verification has run_reference_error_count=${checkpoint.daemon_state_verification.run_reference_error_count}`
      );
    }
    if ((checkpoint.daemon_state_verification.processed_event_duplicate_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'daemon_state_verification_event_duplicates',
        `Embedded daemon state verification has processed_event_duplicate_count=${checkpoint.daemon_state_verification.processed_event_duplicate_count}`
      );
    }
  }
  if (checkpoint.artifact_inventory) {
    if (checkpoint.artifact_inventory.read_only !== true) {
      addIssue(issues, 'error', 'artifact_inventory_not_read_only', 'Embedded artifact inventory must be read_only=true');
    }
    if (checkpoint.artifact_inventory.pass !== true) {
      addIssue(issues, 'error', 'artifact_inventory_not_pass', 'Embedded artifact inventory must pass');
    }
    if ((checkpoint.artifact_inventory.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'artifact_inventory_errors',
        `Embedded artifact inventory has error_count=${checkpoint.artifact_inventory.error_count}`
      );
    }
    if ((checkpoint.artifact_inventory.unknown_runtime_file_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'artifact_inventory_unknown_files',
        `Embedded artifact inventory has unknown_runtime_file_count=${checkpoint.artifact_inventory.unknown_runtime_file_count}`
      );
    }
    if ((checkpoint.artifact_inventory.unknown_runtime_dir_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'artifact_inventory_unknown_dirs',
        `Embedded artifact inventory has unknown_runtime_dir_count=${checkpoint.artifact_inventory.unknown_runtime_dir_count}`
      );
    }
    if ((checkpoint.artifact_inventory.non_json_artifact_file_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'artifact_inventory_non_json_files',
        `Embedded artifact inventory has non_json_artifact_file_count=${checkpoint.artifact_inventory.non_json_artifact_file_count}`
      );
    }
    if ((checkpoint.artifact_inventory.json_parse_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'artifact_inventory_json_parse_errors',
        `Embedded artifact inventory has json_parse_error_count=${checkpoint.artifact_inventory.json_parse_error_count}`
      );
    }
  }
  if (checkpoint.runtime_storage_verification) {
    if (checkpoint.runtime_storage_verification.read_only !== true) {
      addIssue(issues, 'error', 'runtime_storage_verification_not_read_only', 'Embedded runtime storage verification must be read_only=true');
    }
    if (checkpoint.runtime_storage_verification.external_write !== false) {
      addIssue(issues, 'error', 'runtime_storage_verification_external_write', 'Embedded runtime storage verification must be external_write=false');
    }
    if (checkpoint.runtime_storage_verification.botland_send !== false) {
      addIssue(issues, 'error', 'runtime_storage_verification_botland_send', 'Embedded runtime storage verification must be botland_send=false');
    }
    if (checkpoint.runtime_storage_verification.pass !== true) {
      addIssue(issues, 'error', 'runtime_storage_verification_not_pass', 'Embedded runtime storage verification must pass');
    }
    if ((checkpoint.runtime_storage_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'runtime_storage_verification_errors',
        `Embedded runtime storage verification has error_count=${checkpoint.runtime_storage_verification.error_count}`
      );
    }
    if ((checkpoint.runtime_storage_verification.disk_free_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'runtime_storage_disk_free_errors',
        `Embedded runtime storage verification has disk_free_error_count=${checkpoint.runtime_storage_verification.disk_free_error_count}`
      );
    }
    if ((checkpoint.runtime_storage_verification.oversized_file_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'runtime_storage_oversized_files',
        `Embedded runtime storage verification has oversized_file_count=${checkpoint.runtime_storage_verification.oversized_file_count}`
      );
    }
  }
  if (checkpoint.systemd_unit_verification) {
    if (checkpoint.systemd_unit_verification.read_only !== true) {
      addIssue(issues, 'error', 'systemd_unit_verification_not_read_only', 'Embedded systemd unit verification must be read_only=true');
    }
    if (checkpoint.systemd_unit_verification.external_write !== false) {
      addIssue(issues, 'error', 'systemd_unit_verification_external_write', 'Embedded systemd unit verification must be external_write=false');
    }
    if (checkpoint.systemd_unit_verification.botland_send !== false) {
      addIssue(issues, 'error', 'systemd_unit_verification_botland_send', 'Embedded systemd unit verification must be botland_send=false');
    }
    if (checkpoint.systemd_unit_verification.pass !== true) {
      addIssue(issues, 'error', 'systemd_unit_verification_not_pass', 'Embedded systemd unit verification must pass');
    }
    if ((checkpoint.systemd_unit_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'systemd_unit_verification_errors',
        `Embedded systemd unit verification has error_count=${checkpoint.systemd_unit_verification.error_count}`
      );
    }
    if ((checkpoint.systemd_unit_verification.preflight_gate_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'systemd_unit_preflight_gate_errors',
        `Embedded systemd unit verification has preflight_gate_error_count=${checkpoint.systemd_unit_verification.preflight_gate_error_count}`
      );
    }
    if ((checkpoint.systemd_unit_verification.runner_safety_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'systemd_unit_runner_safety_errors',
        `Embedded systemd unit verification has runner_safety_error_count=${checkpoint.systemd_unit_verification.runner_safety_error_count}`
      );
    }
    if ((checkpoint.systemd_unit_verification.timer_schedule_error_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'systemd_unit_timer_schedule_errors',
        `Embedded systemd unit verification has timer_schedule_error_count=${checkpoint.systemd_unit_verification.timer_schedule_error_count}`
      );
    }
  }
  if (checkpoint.systemd_runtime_verification) {
    if (checkpoint.systemd_runtime_verification.read_only !== true) {
      addIssue(issues, 'error', 'systemd_runtime_verification_not_read_only', 'Embedded systemd runtime verification must be read_only=true');
    }
    if (checkpoint.systemd_runtime_verification.external_write !== false) {
      addIssue(issues, 'error', 'systemd_runtime_verification_external_write', 'Embedded systemd runtime verification must be external_write=false');
    }
    if (checkpoint.systemd_runtime_verification.botland_send !== false) {
      addIssue(issues, 'error', 'systemd_runtime_verification_botland_send', 'Embedded systemd runtime verification must be botland_send=false');
    }
    const runtimeFailureIsServiceOnly = (checkpoint.systemd_runtime_verification.failed_service_count ?? 0) > 0
      && (checkpoint.systemd_runtime_verification.failed_timer_count ?? 0) === 0
      && (checkpoint.systemd_runtime_verification.inactive_timer_count ?? 0) === 0
      && (checkpoint.systemd_runtime_verification.disabled_timer_count ?? 0) === 0;
    if (checkpoint.systemd_runtime_verification.pass !== true) {
      addIssue(
        issues,
        runtimeFailureIsServiceOnly ? 'warning' : 'error',
        'systemd_runtime_verification_not_pass',
        'Embedded systemd runtime verification must pass'
      );
    }
    if ((checkpoint.systemd_runtime_verification.error_count ?? 0) > 0) {
      addIssue(
        issues,
        runtimeFailureIsServiceOnly ? 'warning' : 'error',
        'systemd_runtime_verification_errors',
        `Embedded systemd runtime verification has error_count=${checkpoint.systemd_runtime_verification.error_count}`
      );
    }
    if ((checkpoint.systemd_runtime_verification.failed_service_count ?? 0) > 0) {
      addIssue(
        issues,
        'warning',
        'systemd_runtime_failed_services',
        `Embedded systemd runtime verification has failed_service_count=${checkpoint.systemd_runtime_verification.failed_service_count}`
      );
    }
    if ((checkpoint.systemd_runtime_verification.failed_timer_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'systemd_runtime_failed_timers',
        `Embedded systemd runtime verification has failed_timer_count=${checkpoint.systemd_runtime_verification.failed_timer_count}`
      );
    }
    if ((checkpoint.systemd_runtime_verification.inactive_timer_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'systemd_runtime_inactive_timers',
        `Embedded systemd runtime verification has inactive_timer_count=${checkpoint.systemd_runtime_verification.inactive_timer_count}`
      );
    }
    if ((checkpoint.systemd_runtime_verification.disabled_timer_count ?? 0) > 0) {
      addIssue(
        issues,
        'error',
        'systemd_runtime_disabled_timers',
        `Embedded systemd runtime verification has disabled_timer_count=${checkpoint.systemd_runtime_verification.disabled_timer_count}`
      );
    }
  }

  const externalActions = numberValue(summary.external_action_count_in_window);
  const successfulSends = numberValue(summary.successful_send_count);
  const inspectedSuccessfulSends = numberValue(summary.inspected_successful_send_count);
  const uninspectedSuccessfulSends = numberValue(summary.uninspected_successful_send_count);
  const successfulSendInspections = numberValue(summary.successful_send_inspection_count);
  const externalWriteActions = numberValue(summary.external_write_action_count);

  if (externalActions > 0) {
    addIssue(issues, 'error', 'external_actions_found', `Summary external_action_count_in_window=${externalActions}`);
  }
  if (uninspectedSuccessfulSends > 0) {
    addIssue(issues, 'error', 'uninspected_successful_send_found', `Summary uninspected_successful_send_count=${uninspectedSuccessfulSends}`);
  }
  if (externalWriteActions > 0) {
    addIssue(issues, 'error', 'external_write_action_found', `Summary external_write_action_count=${externalWriteActions}`);
  }

  const audit = checkpoint.audit_report ?? {};
  const auditExternalActions = numberValue(audit.run_audit?.external_action_count);
  const auditSuccessfulSends = numberValue(audit.action_audit?.successful_send_count);
  const auditInspectedSuccessfulSends = numberValue(audit.action_audit?.inspected_successful_send_count);
  const auditUninspectedSuccessfulSends = numberValue(audit.action_audit?.uninspected_successful_send_count);
  const auditSuccessfulSendInspections = numberValue(audit.action_audit?.successful_send_inspection_count);
  const auditExternalWriteActions = numberValue(audit.action_audit?.external_write_action_count);

  if (auditExternalActions !== externalActions) {
    addIssue(
      issues,
      'warning',
      'external_action_count_mismatch',
      `Summary external_action_count_in_window=${externalActions}, audit run count=${auditExternalActions}`
    );
  }
  if (auditSuccessfulSends !== successfulSends) {
    addIssue(
      issues,
      'warning',
      'successful_send_count_mismatch',
      `Summary successful_send_count=${successfulSends}, audit send count=${auditSuccessfulSends}`
    );
  }
  if (auditInspectedSuccessfulSends !== inspectedSuccessfulSends) {
    addIssue(
      issues,
      'warning',
      'inspected_successful_send_count_mismatch',
      `Summary inspected_successful_send_count=${inspectedSuccessfulSends}, audit inspected send count=${auditInspectedSuccessfulSends}`
    );
  }
  if (auditUninspectedSuccessfulSends !== uninspectedSuccessfulSends) {
    addIssue(
      issues,
      'warning',
      'uninspected_successful_send_count_mismatch',
      `Summary uninspected_successful_send_count=${uninspectedSuccessfulSends}, audit uninspected send count=${auditUninspectedSuccessfulSends}`
    );
  }
  if (auditSuccessfulSendInspections !== successfulSendInspections) {
    addIssue(
      issues,
      'warning',
      'successful_send_inspection_count_mismatch',
      `Summary successful_send_inspection_count=${successfulSendInspections}, audit inspection count=${auditSuccessfulSendInspections}`
    );
  }
  if (auditExternalWriteActions !== externalWriteActions) {
    addIssue(
      issues,
      'warning',
      'external_write_count_mismatch',
      `Summary external_write_action_count=${externalWriteActions}, audit external-write count=${auditExternalWriteActions}`
    );
  }

  if (checkpoint.audit_report?.verdict?.pass !== true) {
    addIssue(issues, 'warning', 'audit_not_pass', 'Embedded audit verdict is not pass=true');
  }
  if (summary.audit_pass !== true) {
    addIssue(issues, 'warning', 'summary_audit_not_pass', 'Summary audit_pass is not true');
  }
  if (summary.health_ok !== true) {
    addIssue(issues, 'warning', 'health_not_ok', 'Summary health_ok is not true');
  }
  if (hasOwn(summary, 'control_audit_pass') && summary.control_audit_pass !== true) {
    addIssue(issues, 'error', 'summary_control_audit_not_pass', 'Summary control_audit_pass is not true');
  }
  if (hasOwn(summary, 'life_state_verification_pass') && summary.life_state_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_life_state_verification_not_pass', 'Summary life_state_verification_pass is not true');
  }
  if (hasOwn(summary, 'action_verification_pass') && summary.action_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_action_verification_not_pass', 'Summary action_verification_pass is not true');
  }
  if (hasOwn(summary, 'draft_state_verification_pass') && summary.draft_state_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_draft_state_verification_not_pass', 'Summary draft_state_verification_pass is not true');
  }
  if (hasOwn(summary, 'run_verification_pass') && summary.run_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_run_verification_not_pass', 'Summary run_verification_pass is not true');
  }
  if (hasOwn(summary, 'daemon_state_verification_pass') && summary.daemon_state_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_daemon_state_verification_not_pass', 'Summary daemon_state_verification_pass is not true');
  }
  if (hasOwn(summary, 'artifact_inventory_pass') && summary.artifact_inventory_pass !== true) {
    addIssue(issues, 'error', 'summary_artifact_inventory_not_pass', 'Summary artifact_inventory_pass is not true');
  }
  if (hasOwn(summary, 'runtime_storage_verification_pass') && summary.runtime_storage_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_runtime_storage_verification_not_pass', 'Summary runtime_storage_verification_pass is not true');
  }
  if (hasOwn(summary, 'systemd_unit_verification_pass') && summary.systemd_unit_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_systemd_unit_verification_not_pass', 'Summary systemd_unit_verification_pass is not true');
  }
  if (hasOwn(summary, 'systemd_runtime_verification_pass') && summary.systemd_runtime_verification_pass !== true) {
    addIssue(issues, 'error', 'summary_systemd_runtime_verification_not_pass', 'Summary systemd_runtime_verification_pass is not true');
  }
  if (
    checkpoint.control_audit
    && hasOwn(summary, 'control_audit_error_count')
    && numberValue(summary.control_audit_error_count) !== (checkpoint.control_audit.errors?.length ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'control_audit_error_count_mismatch',
      `Summary control_audit_error_count=${numberValue(summary.control_audit_error_count)}, control audit errors=${checkpoint.control_audit.errors?.length ?? 0}`
    );
  }
  if (
    checkpoint.action_verification
    && hasOwn(summary, 'action_verification_error_count')
    && numberValue(summary.action_verification_error_count) !== (checkpoint.action_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'action_verification_error_count_mismatch',
      `Summary action_verification_error_count=${numberValue(summary.action_verification_error_count)}, action verification errors=${checkpoint.action_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.draft_state_verification
    && hasOwn(summary, 'draft_state_verification_error_count')
    && numberValue(summary.draft_state_verification_error_count) !== (checkpoint.draft_state_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'draft_state_verification_error_count_mismatch',
      `Summary draft_state_verification_error_count=${numberValue(summary.draft_state_verification_error_count)}, draft state verification errors=${checkpoint.draft_state_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.life_state_verification
    && hasOwn(summary, 'life_state_verification_error_count')
    && numberValue(summary.life_state_verification_error_count) !== (checkpoint.life_state_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'life_state_verification_error_count_mismatch',
      `Summary life_state_verification_error_count=${numberValue(summary.life_state_verification_error_count)}, life state verification errors=${checkpoint.life_state_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.life_state_verification
    && hasOwn(summary, 'life_state_write_policy_error_count')
    && numberValue(summary.life_state_write_policy_error_count) !== (checkpoint.life_state_verification.write_policy_error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'life_state_write_policy_error_count_mismatch',
      `Summary life_state_write_policy_error_count=${numberValue(summary.life_state_write_policy_error_count)}, life state verification count=${checkpoint.life_state_verification.write_policy_error_count ?? 0}`
    );
  }
  if (
    checkpoint.run_verification
    && hasOwn(summary, 'run_verification_error_count')
    && numberValue(summary.run_verification_error_count) !== (checkpoint.run_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'run_verification_error_count_mismatch',
      `Summary run_verification_error_count=${numberValue(summary.run_verification_error_count)}, run verification errors=${checkpoint.run_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.daemon_state_verification
    && hasOwn(summary, 'daemon_state_verification_error_count')
    && numberValue(summary.daemon_state_verification_error_count) !== (checkpoint.daemon_state_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'daemon_state_verification_error_count_mismatch',
      `Summary daemon_state_verification_error_count=${numberValue(summary.daemon_state_verification_error_count)}, daemon state verification errors=${checkpoint.daemon_state_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.artifact_inventory
    && hasOwn(summary, 'artifact_inventory_error_count')
    && numberValue(summary.artifact_inventory_error_count) !== (checkpoint.artifact_inventory.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'artifact_inventory_error_count_mismatch',
      `Summary artifact_inventory_error_count=${numberValue(summary.artifact_inventory_error_count)}, artifact inventory errors=${checkpoint.artifact_inventory.error_count ?? 0}`
    );
  }
  if (
    checkpoint.runtime_storage_verification
    && hasOwn(summary, 'runtime_storage_verification_error_count')
    && numberValue(summary.runtime_storage_verification_error_count) !== (checkpoint.runtime_storage_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'runtime_storage_verification_error_count_mismatch',
      `Summary runtime_storage_verification_error_count=${numberValue(summary.runtime_storage_verification_error_count)}, runtime storage verification errors=${checkpoint.runtime_storage_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.systemd_unit_verification
    && hasOwn(summary, 'systemd_unit_verification_error_count')
    && numberValue(summary.systemd_unit_verification_error_count) !== (checkpoint.systemd_unit_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'systemd_unit_verification_error_count_mismatch',
      `Summary systemd_unit_verification_error_count=${numberValue(summary.systemd_unit_verification_error_count)}, systemd unit verification errors=${checkpoint.systemd_unit_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.systemd_runtime_verification
    && hasOwn(summary, 'systemd_runtime_verification_error_count')
    && numberValue(summary.systemd_runtime_verification_error_count) !== (checkpoint.systemd_runtime_verification.error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'systemd_runtime_verification_error_count_mismatch',
      `Summary systemd_runtime_verification_error_count=${numberValue(summary.systemd_runtime_verification_error_count)}, systemd runtime verification errors=${checkpoint.systemd_runtime_verification.error_count ?? 0}`
    );
  }
  if (
    checkpoint.daemon_state_verification
    && hasOwn(summary, 'daemon_state_run_reference_error_count')
    && numberValue(summary.daemon_state_run_reference_error_count) !== (checkpoint.daemon_state_verification.run_reference_error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'daemon_state_run_reference_error_count_mismatch',
      `Summary daemon_state_run_reference_error_count=${numberValue(summary.daemon_state_run_reference_error_count)}, daemon state verification count=${checkpoint.daemon_state_verification.run_reference_error_count ?? 0}`
    );
  }
  if (
    checkpoint.run_verification
    && hasOwn(summary, 'run_path_mismatch_count')
    && numberValue(summary.run_path_mismatch_count) !== (checkpoint.run_verification.run_path_mismatch_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'run_path_mismatch_count_mismatch',
      `Summary run_path_mismatch_count=${numberValue(summary.run_path_mismatch_count)}, run verification count=${checkpoint.run_verification.run_path_mismatch_count ?? 0}`
    );
  }
  if (
    checkpoint.run_verification
    && hasOwn(summary, 'run_external_action_count')
    && numberValue(summary.run_external_action_count) !== (checkpoint.run_verification.external_action_run_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'run_external_action_count_mismatch',
      `Summary run_external_action_count=${numberValue(summary.run_external_action_count)}, run verification count=${checkpoint.run_verification.external_action_run_count ?? 0}`
    );
  }
  if (
    checkpoint.run_verification
    && hasOwn(summary, 'run_draft_safety_error_count')
    && numberValue(summary.run_draft_safety_error_count) !== (checkpoint.run_verification.draft_safety_error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'run_draft_safety_error_count_mismatch',
      `Summary run_draft_safety_error_count=${numberValue(summary.run_draft_safety_error_count)}, run verification count=${checkpoint.run_verification.draft_safety_error_count ?? 0}`
    );
  }
  if (
    checkpoint.action_verification
    && hasOwn(summary, 'action_preflight_gate_missing_count')
    && numberValue(summary.action_preflight_gate_missing_count) !== (checkpoint.action_verification.preflight_gate_missing_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'action_preflight_gate_missing_count_mismatch',
      `Summary action_preflight_gate_missing_count=${numberValue(summary.action_preflight_gate_missing_count)}, action verification count=${checkpoint.action_verification.preflight_gate_missing_count ?? 0}`
    );
  }
  if (
    checkpoint.action_verification
    && hasOwn(summary, 'action_preflight_gate_stale_count')
    && numberValue(summary.action_preflight_gate_stale_count) !== (checkpoint.action_verification.preflight_gate_stale_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'action_preflight_gate_stale_count_mismatch',
      `Summary action_preflight_gate_stale_count=${numberValue(summary.action_preflight_gate_stale_count)}, action verification count=${checkpoint.action_verification.preflight_gate_stale_count ?? 0}`
    );
  }
  if (
    checkpoint.action_verification
    && hasOwn(summary, 'action_path_mismatch_count')
    && numberValue(summary.action_path_mismatch_count) !== (checkpoint.action_verification.action_path_mismatch_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'action_path_mismatch_count_mismatch',
      `Summary action_path_mismatch_count=${numberValue(summary.action_path_mismatch_count)}, action verification count=${checkpoint.action_verification.action_path_mismatch_count ?? 0}`
    );
  }
  if (
    checkpoint.action_verification
    && hasOwn(summary, 'action_draft_reference_error_count')
    && numberValue(summary.action_draft_reference_error_count) !== (checkpoint.action_verification.draft_reference_error_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'action_draft_reference_error_count_mismatch',
      `Summary action_draft_reference_error_count=${numberValue(summary.action_draft_reference_error_count)}, action verification count=${checkpoint.action_verification.draft_reference_error_count ?? 0}`
    );
  }
  if (
    checkpoint.action_verification
    && hasOwn(summary, 'action_draft_text_hash_mismatch_count')
    && numberValue(summary.action_draft_text_hash_mismatch_count) !== (checkpoint.action_verification.draft_text_hash_mismatch_count ?? 0)
  ) {
    addIssue(
      issues,
      'warning',
      'action_draft_text_hash_mismatch_count_mismatch',
      `Summary action_draft_text_hash_mismatch_count=${numberValue(summary.action_draft_text_hash_mismatch_count)}, action verification count=${checkpoint.action_verification.draft_text_hash_mismatch_count ?? 0}`
    );
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    checkpoint_id: checkpoint.checkpoint_id ?? path.basename(file, '.json'),
    checkpoint_path: relativePath,
    generated_at: checkpoint.generated_at ?? null,
    agent_id: checkpoint.agent_id ?? null,
    pass: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues,
    summary: {
      health_ok: summary.health_ok ?? null,
      control_audit_pass: summary.control_audit_pass ?? null,
      control_audit_level: summary.control_audit_level ?? null,
      control_audit_error_count: summary.control_audit_error_count ?? null,
      life_state_verification_pass: summary.life_state_verification_pass ?? null,
      life_state_verification_level: summary.life_state_verification_level ?? null,
      life_state_verification_error_count: summary.life_state_verification_error_count ?? null,
      life_state_write_policy_error_count: summary.life_state_write_policy_error_count ?? null,
      life_state_unsafe_allowed_write_type_count: summary.life_state_unsafe_allowed_write_type_count ?? null,
      life_state_writes_enabled_count: summary.life_state_writes_enabled_count ?? null,
      life_state_rate_limit_error_count: summary.life_state_rate_limit_error_count ?? null,
      life_state_botland_identity_error_count: summary.life_state_botland_identity_error_count ?? null,
      action_verification_pass: summary.action_verification_pass ?? null,
      action_verification_level: summary.action_verification_level ?? null,
      action_verification_error_count: summary.action_verification_error_count ?? null,
      action_preflight_gate_missing_count: summary.action_preflight_gate_missing_count ?? null,
      action_preflight_gate_stale_count: summary.action_preflight_gate_stale_count ?? null,
      action_path_mismatch_count: summary.action_path_mismatch_count ?? null,
      action_draft_reference_error_count: summary.action_draft_reference_error_count ?? null,
      action_draft_text_hash_mismatch_count: summary.action_draft_text_hash_mismatch_count ?? null,
      draft_state_verification_pass: summary.draft_state_verification_pass ?? null,
      draft_state_verification_level: summary.draft_state_verification_level ?? null,
      draft_state_verification_error_count: summary.draft_state_verification_error_count ?? null,
      draft_state_conflict_error_count: summary.draft_state_conflict_error_count ?? null,
      draft_state_approved_hash_mismatch_count: summary.draft_state_approved_hash_mismatch_count ?? null,
      draft_state_ready_safety_error_count: summary.draft_state_ready_safety_error_count ?? null,
      run_verification_pass: summary.run_verification_pass ?? null,
      run_verification_level: summary.run_verification_level ?? null,
      run_verification_error_count: summary.run_verification_error_count ?? null,
      run_path_mismatch_count: summary.run_path_mismatch_count ?? null,
      run_external_action_count: summary.run_external_action_count ?? null,
      run_draft_safety_error_count: summary.run_draft_safety_error_count ?? null,
      daemon_state_verification_pass: summary.daemon_state_verification_pass ?? null,
      daemon_state_verification_level: summary.daemon_state_verification_level ?? null,
      daemon_state_verification_error_count: summary.daemon_state_verification_error_count ?? null,
      daemon_state_run_reference_error_count: summary.daemon_state_run_reference_error_count ?? null,
      daemon_state_processed_event_duplicate_count: summary.daemon_state_processed_event_duplicate_count ?? null,
      artifact_inventory_pass: summary.artifact_inventory_pass ?? null,
      artifact_inventory_level: summary.artifact_inventory_level ?? null,
      artifact_inventory_error_count: summary.artifact_inventory_error_count ?? null,
      artifact_unknown_file_count: summary.artifact_unknown_file_count ?? null,
      artifact_unknown_dir_count: summary.artifact_unknown_dir_count ?? null,
      artifact_non_json_file_count: summary.artifact_non_json_file_count ?? null,
      artifact_json_parse_error_count: summary.artifact_json_parse_error_count ?? null,
      runtime_storage_verification_pass: summary.runtime_storage_verification_pass ?? null,
      runtime_storage_verification_level: summary.runtime_storage_verification_level ?? null,
      runtime_storage_verification_error_count: summary.runtime_storage_verification_error_count ?? null,
      runtime_storage_disk_free_error_count: summary.runtime_storage_disk_free_error_count ?? null,
      runtime_storage_oversized_file_count: summary.runtime_storage_oversized_file_count ?? null,
      systemd_unit_verification_pass: summary.systemd_unit_verification_pass ?? null,
      systemd_unit_verification_level: summary.systemd_unit_verification_level ?? null,
      systemd_unit_verification_error_count: summary.systemd_unit_verification_error_count ?? null,
      systemd_unit_preflight_gate_error_count: summary.systemd_unit_preflight_gate_error_count ?? null,
      systemd_unit_runner_safety_error_count: summary.systemd_unit_runner_safety_error_count ?? null,
      systemd_unit_timer_schedule_error_count: summary.systemd_unit_timer_schedule_error_count ?? null,
      systemd_runtime_verification_pass: summary.systemd_runtime_verification_pass ?? null,
      systemd_runtime_verification_level: summary.systemd_runtime_verification_level ?? null,
      systemd_runtime_verification_error_count: summary.systemd_runtime_verification_error_count ?? null,
      systemd_runtime_failed_service_count: summary.systemd_runtime_failed_service_count ?? null,
      systemd_runtime_failed_timer_count: summary.systemd_runtime_failed_timer_count ?? null,
      systemd_runtime_inactive_timer_count: summary.systemd_runtime_inactive_timer_count ?? null,
      systemd_runtime_disabled_timer_count: summary.systemd_runtime_disabled_timer_count ?? null,
      latest_run_id: summary.latest_run_id ?? null,
      operator_decision: summary.operator_decision ?? null,
      audit_verdict: summary.audit_verdict ?? null,
      audit_pass: summary.audit_pass ?? null,
      pending_draft_count: summary.pending_draft_count ?? null,
      approved_draft_count: summary.approved_draft_count ?? null,
      visible_draft_count: summary.visible_draft_count ?? null,
      external_action_count_in_window: summary.external_action_count_in_window ?? null,
      successful_send_count: summary.successful_send_count ?? null,
      inspected_successful_send_count: summary.inspected_successful_send_count ?? null,
      uninspected_successful_send_count: summary.uninspected_successful_send_count ?? null,
      successful_send_inspection_count: summary.successful_send_inspection_count ?? null,
      external_write_action_count: summary.external_write_action_count ?? null
    }
  };
}

function buildReport(args) {
  const files = listCheckpointFiles(args.checkpointDir, args.limit);
  const checkpoints = files.map((file) => verifyCheckpoint(file, args.agent));
  const errorCount = checkpoints.reduce((sum, checkpoint) => sum + checkpoint.error_count, 0);
  const warningCount = checkpoints.reduce((sum, checkpoint) => sum + checkpoint.warning_count, 0);
  const checkpointPathMismatchCount = checkpoints.reduce(
    (sum, checkpoint) => sum + (checkpoint.issues.some((issue) => issue.code === 'checkpoint_path_id_mismatch') ? 1 : 0),
    0
  );

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    checkpoint_dir: path.relative(WORKSPACE, args.checkpointDir),
    checkpoint_count: checkpoints.length,
    checkpoint_path_mismatch_count: checkpointPathMismatchCount,
    pass: errorCount === 0,
    error_count: errorCount,
    warning_count: warningCount,
    checkpoints
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive checkpoint verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`checkpoint_dir: ${report.checkpoint_dir}`);
  lines.push(`checkpoint_count: ${report.checkpoint_count}`);
  lines.push(`checkpoint_path_mismatch_count: ${report.checkpoint_path_mismatch_count}`);
  lines.push(`pass: ${boolLabel(report.pass)}`);
  lines.push(`errors: ${report.error_count}`);
  lines.push(`warnings: ${report.warning_count}`);
  lines.push('');

  if (report.checkpoints.length === 0) {
    lines.push('No checkpoint artifacts found.');
  } else {
    lines.push('Checkpoints');
    for (const checkpoint of report.checkpoints) {
      lines.push(`- ${checkpoint.generated_at ?? 'unknown'} ${checkpoint.checkpoint_id}`);
      lines.push(`  path: ${checkpoint.checkpoint_path}`);
      lines.push(`  pass: ${boolLabel(checkpoint.pass)} errors=${checkpoint.error_count} warnings=${checkpoint.warning_count}`);
      lines.push(`  latest_run: ${checkpoint.summary?.latest_run_id ?? 'none'}`);
      lines.push(
        `  control_audit: pass=${checkpoint.summary?.control_audit_pass ?? 'n/a'} ` +
        `level=${checkpoint.summary?.control_audit_level ?? 'n/a'} ` +
        `errors=${checkpoint.summary?.control_audit_error_count ?? 'n/a'}`
      );
      lines.push(
        `  safety: external_actions=${checkpoint.summary?.external_action_count_in_window ?? 'n/a'} ` +
        `sends=${checkpoint.summary?.successful_send_count ?? 'n/a'} ` +
        `inspected_sends=${checkpoint.summary?.inspected_successful_send_count ?? 'n/a'} ` +
        `uninspected_sends=${checkpoint.summary?.uninspected_successful_send_count ?? 'n/a'} ` +
        `send_inspections=${checkpoint.summary?.successful_send_inspection_count ?? 'n/a'} ` +
        `external_writes=${checkpoint.summary?.external_write_action_count ?? 'n/a'}`
      );
      lines.push(
        `  run_verification: pass=${checkpoint.summary?.run_verification_pass ?? 'n/a'} ` +
        `level=${checkpoint.summary?.run_verification_level ?? 'n/a'} ` +
        `errors=${checkpoint.summary?.run_verification_error_count ?? 'n/a'} ` +
        `path_mismatch=${checkpoint.summary?.run_path_mismatch_count ?? 'n/a'}`
      );
      lines.push(
        `  daemon_state_verification: pass=${checkpoint.summary?.daemon_state_verification_pass ?? 'n/a'} ` +
        `level=${checkpoint.summary?.daemon_state_verification_level ?? 'n/a'} ` +
        `errors=${checkpoint.summary?.daemon_state_verification_error_count ?? 'n/a'} ` +
        `run_refs=${checkpoint.summary?.daemon_state_run_reference_error_count ?? 'n/a'}`
      );
      lines.push(
        `  artifact_inventory: pass=${checkpoint.summary?.artifact_inventory_pass ?? 'n/a'} ` +
        `level=${checkpoint.summary?.artifact_inventory_level ?? 'n/a'} ` +
        `errors=${checkpoint.summary?.artifact_inventory_error_count ?? 'n/a'} ` +
        `unknown_files=${checkpoint.summary?.artifact_unknown_file_count ?? 'n/a'} ` +
        `non_json=${checkpoint.summary?.artifact_non_json_file_count ?? 'n/a'}`
      );
      lines.push(
        `  runtime_storage: pass=${checkpoint.summary?.runtime_storage_verification_pass ?? 'n/a'} ` +
        `level=${checkpoint.summary?.runtime_storage_verification_level ?? 'n/a'} ` +
        `errors=${checkpoint.summary?.runtime_storage_verification_error_count ?? 'n/a'} ` +
        `disk_free=${checkpoint.summary?.runtime_storage_disk_free_error_count ?? 'n/a'} ` +
        `oversized=${checkpoint.summary?.runtime_storage_oversized_file_count ?? 'n/a'}`
      );
      lines.push(
        `  systemd_units: pass=${checkpoint.summary?.systemd_unit_verification_pass ?? 'n/a'} ` +
        `level=${checkpoint.summary?.systemd_unit_verification_level ?? 'n/a'} ` +
        `errors=${checkpoint.summary?.systemd_unit_verification_error_count ?? 'n/a'} ` +
        `preflight=${checkpoint.summary?.systemd_unit_preflight_gate_error_count ?? 'n/a'} ` +
        `runner=${checkpoint.summary?.systemd_unit_runner_safety_error_count ?? 'n/a'} ` +
        `schedule=${checkpoint.summary?.systemd_unit_timer_schedule_error_count ?? 'n/a'}`
      );
      lines.push(
        `  systemd_runtime: pass=${checkpoint.summary?.systemd_runtime_verification_pass ?? 'n/a'} ` +
        `level=${checkpoint.summary?.systemd_runtime_verification_level ?? 'n/a'} ` +
        `errors=${checkpoint.summary?.systemd_runtime_verification_error_count ?? 'n/a'} ` +
        `failed_services=${checkpoint.summary?.systemd_runtime_failed_service_count ?? 'n/a'} ` +
        `failed_timers=${checkpoint.summary?.systemd_runtime_failed_timer_count ?? 'n/a'} ` +
        `inactive_timers=${checkpoint.summary?.systemd_runtime_inactive_timer_count ?? 'n/a'} ` +
        `disabled_timers=${checkpoint.summary?.systemd_runtime_disabled_timer_count ?? 'n/a'}`
      );
      for (const issue of checkpoint.issues) {
        lines.push(`  ${issue.severity}: ${issue.code}: ${issue.message}`);
      }
    }
  }

  lines.push('');
  lines.push('read_only: yes');
  lines.push('external_write: no');

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
