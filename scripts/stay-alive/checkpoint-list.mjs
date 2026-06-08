#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

const SUMMARY_FIELDS = [
  'health_ok',
  'control_audit_pass',
  'control_audit_level',
  'control_audit_error_count',
  'control_audit_warning_count',
  'life_state_verification_pass',
  'life_state_verification_level',
  'life_state_verification_error_count',
  'life_state_verification_warning_count',
  'life_state_write_policy_error_count',
  'life_state_unsafe_allowed_write_type_count',
  'life_state_writes_enabled_count',
  'life_state_rate_limit_error_count',
  'life_state_botland_identity_error_count',
  'action_verification_pass',
  'action_verification_level',
  'action_verification_error_count',
  'action_verification_warning_count',
  'action_preflight_gate_missing_count',
  'action_preflight_gate_failed_count',
  'action_preflight_gate_stale_count',
  'action_path_mismatch_count',
  'action_draft_reference_error_count',
  'action_draft_text_hash_mismatch_count',
  'run_verification_pass',
  'run_verification_level',
  'run_verification_error_count',
  'run_verification_warning_count',
  'run_path_mismatch_count',
  'run_external_action_count',
  'run_draft_safety_error_count',
  'daemon_state_verification_pass',
  'daemon_state_verification_level',
  'daemon_state_verification_error_count',
  'daemon_state_verification_warning_count',
  'daemon_state_last_run_missing_count',
  'daemon_state_run_reference_error_count',
  'daemon_state_processed_event_duplicate_count',
  'artifact_inventory_pass',
  'artifact_inventory_level',
  'artifact_inventory_error_count',
  'artifact_inventory_warning_count',
  'artifact_unknown_file_count',
  'artifact_unknown_dir_count',
  'artifact_non_json_file_count',
  'artifact_unexpected_subdir_count',
  'artifact_json_parse_error_count',
  'artifact_required_missing_count',
  'systemd_unit_verification_pass',
  'systemd_unit_verification_level',
  'systemd_unit_verification_error_count',
  'systemd_unit_preflight_gate_error_count',
  'systemd_unit_runner_safety_error_count',
  'systemd_unit_timer_schedule_error_count',
  'systemd_runtime_verification_pass',
  'systemd_runtime_verification_level',
  'systemd_runtime_verification_error_count',
  'systemd_runtime_failed_service_count',
  'systemd_runtime_failed_timer_count',
  'systemd_runtime_inactive_timer_count',
  'systemd_runtime_disabled_timer_count',
  'operator_paused',
  'operator_paused_raw',
  'pause_until',
  'pause_expired',
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
  'inspected_successful_send_count',
  'uninspected_successful_send_count',
  'successful_send_inspection_count',
  'external_write_action_count'
];

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 10,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    checkpointDir: null,
    compare: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--checkpoint-dir') args.checkpointDir = path.resolve(argv[++i]);
    else if (arg === '--compare') args.compare = true;
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
  console.log(`Usage: node scripts/stay-alive/checkpoint-list.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --limit <n>              Number of checkpoints to list. Default: 10
  --runtime-root <dir>     Runtime agents directory.
  --checkpoint-dir <dir>   Directory containing checkpoint artifacts.
  --compare                Include field-level diff between newest two checkpoints.
  --json                   Print JSON instead of checkpoint list text.
  --help                   Show this help.

This command is read-only. It only reads local checkpoint artifacts and never
approves drafts, dismisses drafts, or sends BotLand messages.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
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

function compactCheckpoint(checkpoint, file) {
  const checkpointId = checkpoint.checkpoint_id ?? path.basename(file, '.json');
  const expectedFilename = `${checkpointId}.json`;
  const actualFilename = path.basename(file);

  return {
    checkpoint_id: checkpointId,
    checkpoint_path: path.relative(WORKSPACE, file),
    checkpoint_path_matches_id: actualFilename === expectedFilename,
    expected_filename: expectedFilename,
    actual_filename: actualFilename,
    generated_at: checkpoint.generated_at ?? null,
    agent_id: checkpoint.agent_id ?? null,
    limit: checkpoint.limit ?? null,
    local_only: checkpoint.local_only === true,
    external_write: checkpoint.external_write === true,
    summary: checkpoint.summary ?? {}
  };
}

function compareSummaries(newer, older) {
  if (!newer || !older) return [];

  const changes = [];
  const fields = new Set([
    ...SUMMARY_FIELDS,
    ...Object.keys(newer.summary ?? {}),
    ...Object.keys(older.summary ?? {})
  ]);

  for (const field of fields) {
    const current = newer.summary?.[field] ?? null;
    const previous = older.summary?.[field] ?? null;
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      changes.push({ field, previous, current });
    }
  }

  return changes;
}

function buildReport(args) {
  const files = listCheckpointFiles(args.checkpointDir, args.limit);
  const checkpoints = files.map((file) => compactCheckpoint(readJson(file), file));
  const changes = args.compare ? compareSummaries(checkpoints[0], checkpoints[1]) : [];
  const pathMismatchCount = checkpoints.filter((checkpoint) => checkpoint.checkpoint_path_matches_id !== true).length;

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    checkpoint_dir: path.relative(WORKSPACE, args.checkpointDir),
    checkpoint_count: checkpoints.length,
    checkpoint_path_mismatch_count: pathMismatchCount,
    checkpoints,
    compare_newest_two: args.compare
      ? {
          available: checkpoints.length >= 2,
          newer_checkpoint_id: checkpoints[0]?.checkpoint_id ?? null,
          older_checkpoint_id: checkpoints[1]?.checkpoint_id ?? null,
          change_count: changes.length,
          changes
        }
      : null
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatSummary(summary) {
  return [
    `health=${boolLabel(summary.health_ok)}`,
    `control=${summary.control_audit_level ?? 'n/a'}/${summary.control_audit_pass === undefined ? 'n/a' : boolLabel(summary.control_audit_pass)}`,
    `control_errors=${summary.control_audit_error_count ?? 'n/a'}`,
    `life=${summary.life_state_verification_level ?? 'n/a'}/${summary.life_state_verification_pass === undefined ? 'n/a' : boolLabel(summary.life_state_verification_pass)}`,
    `life_errors=${summary.life_state_verification_error_count ?? 'n/a'}`,
    `life_policy_errors=${summary.life_state_write_policy_error_count ?? 'n/a'}`,
    `life_unsafe_writes=${summary.life_state_unsafe_allowed_write_type_count ?? 'n/a'}`,
    `life_writes_enabled=${summary.life_state_writes_enabled_count ?? 'n/a'}`,
    `life_rate_errors=${summary.life_state_rate_limit_error_count ?? 'n/a'}`,
    `life_identity_errors=${summary.life_state_botland_identity_error_count ?? 'n/a'}`,
    `actions=${summary.action_verification_level ?? 'n/a'}/${summary.action_verification_pass === undefined ? 'n/a' : boolLabel(summary.action_verification_pass)}`,
    `action_errors=${summary.action_verification_error_count ?? 'n/a'}`,
    `action_stale_gate=${summary.action_preflight_gate_stale_count ?? 'n/a'}`,
    `action_path_mismatch=${summary.action_path_mismatch_count ?? 'n/a'}`,
    `action_draft_refs=${summary.action_draft_reference_error_count ?? 'n/a'}`,
    `action_hash_mismatch=${summary.action_draft_text_hash_mismatch_count ?? 'n/a'}`,
    `runs=${summary.run_verification_level ?? 'n/a'}/${summary.run_verification_pass === undefined ? 'n/a' : boolLabel(summary.run_verification_pass)}`,
    `run_errors=${summary.run_verification_error_count ?? 'n/a'}`,
    `run_path_mismatch=${summary.run_path_mismatch_count ?? 'n/a'}`,
    `run_external_actions=${summary.run_external_action_count ?? 'n/a'}`,
    `run_draft_safety=${summary.run_draft_safety_error_count ?? 'n/a'}`,
    `daemon=${summary.daemon_state_verification_level ?? 'n/a'}/${summary.daemon_state_verification_pass === undefined ? 'n/a' : boolLabel(summary.daemon_state_verification_pass)}`,
    `daemon_errors=${summary.daemon_state_verification_error_count ?? 'n/a'}`,
    `daemon_run_refs=${summary.daemon_state_run_reference_error_count ?? 'n/a'}`,
    `daemon_event_dupes=${summary.daemon_state_processed_event_duplicate_count ?? 'n/a'}`,
    `artifacts=${summary.artifact_inventory_level ?? 'n/a'}/${summary.artifact_inventory_pass === undefined ? 'n/a' : boolLabel(summary.artifact_inventory_pass)}`,
    `artifact_errors=${summary.artifact_inventory_error_count ?? 'n/a'}`,
    `artifact_unknown_files=${summary.artifact_unknown_file_count ?? 'n/a'}`,
    `artifact_non_json=${summary.artifact_non_json_file_count ?? 'n/a'}`,
    `systemd_units=${summary.systemd_unit_verification_level ?? 'n/a'}/${summary.systemd_unit_verification_pass === undefined ? 'n/a' : boolLabel(summary.systemd_unit_verification_pass)}`,
    `systemd_unit_errors=${summary.systemd_unit_verification_error_count ?? 'n/a'}`,
    `systemd_runtime=${summary.systemd_runtime_verification_level ?? 'n/a'}/${summary.systemd_runtime_verification_pass === undefined ? 'n/a' : boolLabel(summary.systemd_runtime_verification_pass)}`,
    `systemd_runtime_errors=${summary.systemd_runtime_verification_error_count ?? 'n/a'}`,
    `systemd_runtime_failed_services=${summary.systemd_runtime_failed_service_count ?? 'n/a'}`,
    `systemd_runtime_failed_timers=${summary.systemd_runtime_failed_timer_count ?? 'n/a'}`,
    `systemd_runtime_inactive_timers=${summary.systemd_runtime_inactive_timer_count ?? 'n/a'}`,
    `paused=${summary.operator_paused === undefined ? 'n/a' : boolLabel(summary.operator_paused)}`,
    `pause_expired=${summary.pause_expired === undefined ? 'n/a' : boolLabel(summary.pause_expired)}`,
    `decision=${summary.operator_decision ?? 'unknown'}`,
    `audit=${summary.audit_verdict ?? 'unknown'}/${boolLabel(summary.audit_pass)}`,
    `pending=${summary.pending_draft_count ?? 0}`,
    `approved=${summary.approved_draft_count ?? 0}`,
    `visible=${summary.visible_draft_count ?? 0}`,
    `external_actions=${summary.external_action_count_in_window ?? 0}`,
    `sends=${summary.successful_send_count ?? 0}`,
    `inspected_sends=${summary.inspected_successful_send_count ?? 0}`,
    `uninspected_sends=${summary.uninspected_successful_send_count ?? 0}`,
    `send_inspections=${summary.successful_send_inspection_count ?? 0}`,
    `external_writes=${summary.external_write_action_count ?? 0}`
  ].join(' ');
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive checkpoint list (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`checkpoint_dir: ${report.checkpoint_dir}`);
  lines.push(`checkpoint_count: ${report.checkpoint_count}`);
  lines.push(`checkpoint_path_mismatch_count: ${report.checkpoint_path_mismatch_count}`);
  lines.push('');

  if (report.checkpoints.length === 0) {
    lines.push('No checkpoint artifacts found.');
  } else {
    lines.push('Checkpoints');
    for (const checkpoint of report.checkpoints) {
      lines.push(`- ${checkpoint.generated_at ?? 'unknown'} ${checkpoint.checkpoint_id}`);
      lines.push(`  path: ${checkpoint.checkpoint_path}`);
      lines.push(`  path_matches_id: ${boolLabel(checkpoint.checkpoint_path_matches_id)}`);
      lines.push(`  latest_run: ${checkpoint.summary.latest_run_id ?? 'none'}`);
      lines.push(`  summary: ${formatSummary(checkpoint.summary)}`);
    }
  }

  if (report.compare_newest_two) {
    const comparison = report.compare_newest_two;
    lines.push('');
    lines.push('Newest checkpoint diff');
    if (!comparison.available) {
      lines.push('- unavailable: need at least two checkpoints');
    } else if (comparison.change_count === 0) {
      lines.push(`- no summary changes between ${comparison.older_checkpoint_id} and ${comparison.newer_checkpoint_id}`);
    } else {
      lines.push(`- ${comparison.change_count} summary change(s)`);
      for (const change of comparison.changes) {
        lines.push(`  ${change.field}: ${JSON.stringify(change.previous)} -> ${JSON.stringify(change.current)}`);
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
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
