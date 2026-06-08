#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  inspectedSuccessfulSends,
  readOutcomeIndex
} from './action-outcome-lib.mjs';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 10,
    draftLimit: null,
    historyLimit: 3,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    checkpointDir: null,
    format: 'text',
    showText: false
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
  if (!Number.isInteger(args.historyLimit) || args.historyLimit < 1) {
    throw new Error('--history-limit must be a positive integer');
  }
  if (!args.checkpointDir) {
    args.checkpointDir = path.join(args.runtimeRoot, args.agent, 'checkpoints');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/operator-console.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Recent run window. Default: 10
  --draft-limit <n>     Recent run window for draft lookup. Default: max(limit, 200)
  --history-limit <n>   Recent checkpoint window. Default: 3
  --runtime-root <dir>  Runtime agents directory.
  --checkpoint-dir <dir>
                        Directory containing checkpoint artifacts.
  --json                Print JSON instead of operator text.
  --show-text           Include full draft text in the embedded packet.
  --help                Show this help.

This command is read-only. It summarizes status, recent checkpoint history, and
the latest visible draft packet, but it never writes action artifacts and never
sends BotLand messages.

It is a boundary facility, not an agency source. Use it to inspect, block, and
recover around the agent life loop; do not use it to author the agent's desires
or direction.
`);
}

function runtimeRootArgs(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function runJson(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: WORKSPACE,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `Command failed: ${script}`;
    throw new Error(message);
  }

  return JSON.parse(result.stdout);
}

function loadStatus(args) {
  return runJson('scripts/stay-alive/status.mjs', [
    '--agent',
    args.agent,
    '--limit',
    String(args.limit),
    '--draft-limit',
    String(args.draftLimit),
    ...runtimeRootArgs(args)
  ]);
}

function loadLatestPacket(args, status) {
  if ((status.health?.visible_draft_count ?? 0) < 1) return null;

  return runJson('scripts/stay-alive/draft-packet.mjs', [
    '--agent',
    args.agent,
    '--limit',
    String(args.draftLimit),
    ...runtimeRootArgs(args),
    ...(args.showText ? [] : ['--redact-text'])
  ]);
}

function loadCheckpointHistory(args) {
  return runJson('scripts/stay-alive/checkpoint-list.mjs', [
    '--agent',
    args.agent,
    '--limit',
    String(args.historyLimit),
    '--checkpoint-dir',
    args.checkpointDir,
    '--compare',
    '--json'
  ]);
}

function loadProposalGovernance(args) {
  return runJson('scripts/stay-alive/proposal-governor.mjs', [
    '--agent',
    args.agent,
    '--limit',
    String(Math.max(args.limit, 80)),
    ...runtimeRootArgs(args),
    '--json'
  ]);
}

function loadSystemdRuntime(args) {
  return runJson('scripts/stay-alive/systemd-runtime-verify.mjs', [
    '--agent',
    args.agent,
    ...runtimeRootArgs(args),
    '--json'
  ]);
}

function summarizeCheckpointHistory(history) {
  const latest = history.checkpoints?.[0] ?? null;
  return {
    checkpoint_count: history.checkpoint_count ?? 0,
    checkpoint_path_mismatch_count: history.checkpoint_path_mismatch_count ?? 0,
    latest_checkpoint_id: latest?.checkpoint_id ?? null,
    latest_generated_at: latest?.generated_at ?? null,
    latest_summary: latest?.summary ?? null,
    newest_two_change_count: history.compare_newest_two?.change_count ?? null,
    newest_two_changes: history.compare_newest_two?.changes ?? []
  };
}

function summarizeSystemdRuntime(runtime) {
  const failedServices = (runtime.services ?? []).filter((unit) => {
    return unit.properties?.ActiveState === 'failed' || unit.properties?.Result === 'failed';
  });
  const failedTimers = (runtime.timers ?? []).filter((unit) => {
    return unit.properties?.ActiveState === 'failed' || unit.properties?.Result === 'failed';
  });
  const inactiveTimers = (runtime.timers ?? []).filter((unit) => {
    return unit.exists === true && unit.properties?.ActiveState !== 'active';
  });
  const failedUnits = [...failedServices, ...failedTimers];

  return {
    read_only: runtime.read_only === true,
    pass: runtime.pass,
    level: runtime.level,
    service_count: runtime.service_count ?? 0,
    timer_count: runtime.timer_count ?? 0,
    existing_service_count: runtime.existing_service_count ?? 0,
    existing_timer_count: runtime.existing_timer_count ?? 0,
    missing_service_count: runtime.missing_service_count ?? 0,
    missing_timer_count: runtime.missing_timer_count ?? 0,
    failed_service_count: runtime.failed_service_count ?? failedServices.length,
    failed_timer_count: runtime.failed_timer_count ?? failedTimers.length,
    inactive_timer_count: runtime.inactive_timer_count ?? inactiveTimers.length,
    disabled_timer_count: runtime.disabled_timer_count ?? 0,
    uninspected_failed_service_count: runtime.uninspected_failed_service_count ?? 0,
    inspected_failed_service_count: runtime.inspected_failed_service_count ?? 0,
    failed_units: failedUnits.map((unit) => ({
      unit_name: unit.unit_name,
      type: unit.type,
      active_state: unit.properties?.ActiveState ?? null,
      result: unit.properties?.Result ?? null,
      inspected: unit.failure?.inspected ?? false,
      recovered: unit.failure?.recovered ?? false
    })),
    warning_count: runtime.warning_count ?? 0,
    error_count: runtime.error_count ?? 0
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function loadActionOutcomeSummary(args) {
  const inspected = inspectedSuccessfulSends(args.runtimeRoot, args.agent);
  const outcomes = readOutcomeIndex(args.runtimeRoot, args.agent);
  const pending = inspected.filter((pair) => !outcomes.has(pair.send_action.action_id));
  return {
    inspected_successful_send_count: inspected.length,
    outcome_count: outcomes.size,
    pending_outcome_count: pending.length,
    pending_action_ids: pending.map((pair) => pair.send_action.action_id),
    next_command: `node scripts/stay-alive/action-outcome.mjs --agent ${args.agent} --limit ${Math.max(args.limit, 20)} --dry-run --json`
  };
}

function decide(status, packet, proposalGovernance, actionOutcomes, systemdRuntime) {
  const health = status.health ?? {};
  const control = status.control_state ?? {};
  const runtime = systemdRuntime ?? {};
  if (control.paused === true) {
    return {
      level: 'stop',
      summary: `Operator pause is active${control.pause_reason ? `: ${control.pause_reason}` : ''}${control.pause_until ? ` until ${control.pause_until}` : '.'}`,
      next_command: `node scripts/stay-alive/control-state.mjs status --agent ${status.agent_id}`
    };
  }

  if ((health.external_action_count_in_window ?? 0) > 0) {
    return {
      level: 'stop',
      summary: 'External action detected in recent window; inspect before continuing.',
      next_command: `node scripts/stay-alive/status.mjs --agent ${status.agent_id} --limit ${status.recent_runs?.length ?? 10} --include-applied --show-text`
    };
  }

  if ((runtime.uninspected_failed_service_count ?? 0) > 0) {
    return {
      level: 'stop',
      summary: `${runtime.uninspected_failed_service_count} failed service(s) need inspection before continuing.`,
      next_command: `node scripts/stay-alive/failed-service-packet.mjs --agent ${status.agent_id} --json`
    };
  }

  if ((runtime.failed_service_count ?? 0) > 0 || (runtime.failed_timer_count ?? 0) > 0) {
    return {
      level: 'attention',
      summary: `${runtime.failed_service_count ?? 0} failed service(s) and ${runtime.failed_timer_count ?? 0} failed timer(s) are visible in systemd runtime.`,
      next_command: `node scripts/stay-alive/systemd-runtime-verify.mjs --agent ${status.agent_id} --json`
    };
  }

  if (health.latest_run_needs_attention) {
    return {
      level: 'attention',
      summary: 'Latest run needs attention; inspect BotLand checks or identity status.',
      next_command: `node scripts/stay-alive/status.mjs --agent ${status.agent_id} --limit ${status.recent_runs?.length ?? 10}`
    };
  }

  if ((health.approved_draft_count ?? 0) > 0 && packet) {
    return {
      level: 'approval_waiting',
      summary: 'A draft is approved locally. Sending still needs a separate explicit confirmation.',
      next_command: packet.commands?.send_after_approval_and_second_confirmation ?? null
    };
  }

  if ((health.pending_draft_count ?? 0) > 0 && packet) {
    return {
      level: 'review',
      summary: 'There is a pending draft. Review packet, then approve, dismiss, or leave it pending.',
      next_command: packet.commands?.refresh_packet ?? null
    };
  }

  if ((proposalGovernance?.executable_count ?? 0) > 0) {
    return {
      level: 'proposal_governance',
      summary: `Proposal queue has ${proposalGovernance.executable_count} safe local governance operation(s) ready and ${proposalGovernance.review_count ?? 0} manual-review item(s).`,
      next_command: proposalGovernance.next_commands?.dry_run_batch_apply ?? `node scripts/stay-alive/proposal-governor.mjs --agent ${status.agent_id} --limit 80`
    };
  }

  if ((actionOutcomes?.pending_outcome_count ?? 0) > 0) {
    return {
      level: 'action_outcome',
      summary: `${actionOutcomes.pending_outcome_count} inspected successful send(s) need outcome feedback integration.`,
      next_command: actionOutcomes.next_command
    };
  }

  return {
    level: 'monitor',
    summary: 'No pending visible draft and latest run is healthy. Keep timers draft-only.',
    next_command: `node scripts/stay-alive/status.mjs --agent ${status.agent_id} --limit ${status.recent_runs?.length ?? 10}`
  };
}

function buildConsole(args) {
  const status = loadStatus(args);
  const packet = loadLatestPacket(args, status);
  const checkpointHistory = loadCheckpointHistory(args);
  const proposalGovernance = loadProposalGovernance(args);
  const actionOutcomes = loadActionOutcomeSummary(args);
  const systemdRuntime = summarizeSystemdRuntime(loadSystemdRuntime(args));
  const decision = decide(status, packet, proposalGovernance, actionOutcomes, systemdRuntime);

  return {
    read_only: true,
    facility_class: 'boundary_facility',
    agency_source: false,
    purpose: 'Inspect, block, recover, and record around the agent life loop. Do not author agent desires or direction.',
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    status,
    checkpoint_history: summarizeCheckpointHistory(checkpointHistory),
    proposal_governance: {
      proposal_count: proposalGovernance.proposal_count,
      group_count: proposalGovernance.group_count,
      duplicate_group_count: proposalGovernance.duplicate_group_count,
      visible_count: proposalGovernance.visible_count,
      executable_count: proposalGovernance.executable_count,
      review_count: proposalGovernance.review_count,
      counts_by_decision: proposalGovernance.counts_by_decision,
      counts_by_lane: proposalGovernance.counts_by_lane,
      next_commands: proposalGovernance.next_commands
    },
    action_outcomes: actionOutcomes,
    systemd_runtime: systemdRuntime,
    latest_visible_draft_packet: packet,
    operator_decision: decision
  };
}

function formatText(consoleState) {
  const status = consoleState.status;
  const health = status.health ?? {};
  const daemon = status.daemon_state ?? {};
  const control = status.control_state ?? {};
  const latest = status.latest_run ?? {};
  const packet = consoleState.latest_visible_draft_packet;
  const history = consoleState.checkpoint_history ?? {};
  const latestCheckpoint = history.latest_summary ?? {};
  const systemdRuntime = consoleState.systemd_runtime ?? {};
  const decision = consoleState.operator_decision;
  const lines = [];

  lines.push(`Stay-Alive operator console (${consoleState.agent_id})`);
  lines.push('facility_class: boundary_facility');
  lines.push('agency_source: no');
  lines.push(`generated_at: ${consoleState.generated_at}`);
  lines.push('');
  lines.push('Health');
  lines.push(`- ok: ${boolLabel(health.ok)}`);
  lines.push(`- latest_run: ${latest.run_id ?? 'none'} (${latest.cycle ?? 'unknown'})`);
  lines.push(`- latest_run_needs_attention: ${boolLabel(health.latest_run_needs_attention)}`);
  lines.push(`- historical_attention_run_count: ${health.historical_attention_run_count ?? 0}`);
  lines.push(`- external_action_count_in_window: ${health.external_action_count_in_window ?? 0}`);
  lines.push('');
  lines.push('Daemon');
  lines.push(`- run_count: ${daemon.run_count ?? 0}`);
  lines.push(`- last_seen_event_id: ${daemon.last_seen_event_id ?? 'none'}`);
  lines.push(`- processed_event_count: ${daemon.processed_event_count ?? 0}`);
  lines.push('');
  lines.push('Control');
  lines.push(`- paused: ${boolLabel(control.paused)}`);
  lines.push(`- paused_raw: ${boolLabel(control.paused_raw)}`);
  lines.push(`- paused_at: ${control.paused_at ?? 'none'}`);
  lines.push(`- pause_reason: ${control.pause_reason ?? 'none'}`);
  lines.push(`- pause_until: ${control.pause_until ?? 'none'}`);
  lines.push(`- pause_expired: ${boolLabel(control.pause_expired)}`);
  lines.push('');
  lines.push('Checkpoint History');
  lines.push(`- checkpoint_count: ${history.checkpoint_count ?? 0}`);
  lines.push(`- checkpoint_path_mismatch_count: ${history.checkpoint_path_mismatch_count ?? 0}`);
  lines.push(`- latest_checkpoint: ${history.latest_checkpoint_id ?? 'none'}`);
  lines.push(`- latest_generated_at: ${history.latest_generated_at ?? 'none'}`);
  lines.push(`- latest_control_audit: ${latestCheckpoint.control_audit_level ?? 'n/a'}/${latestCheckpoint.control_audit_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.control_audit_pass)}`);
  lines.push(`- latest_life_state_verification: ${latestCheckpoint.life_state_verification_level ?? 'n/a'}/${latestCheckpoint.life_state_verification_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.life_state_verification_pass)}`);
  lines.push(`- latest_life_state_errors: ${latestCheckpoint.life_state_verification_error_count ?? 'n/a'}`);
  lines.push(`- latest_life_state_policy_errors: ${latestCheckpoint.life_state_write_policy_error_count ?? 'n/a'}`);
  lines.push(`- latest_life_state_unsafe_writes: ${latestCheckpoint.life_state_unsafe_allowed_write_type_count ?? 'n/a'}`);
  lines.push(`- latest_life_state_writes_enabled: ${latestCheckpoint.life_state_writes_enabled_count ?? 'n/a'}`);
  lines.push(`- latest_life_state_rate_errors: ${latestCheckpoint.life_state_rate_limit_error_count ?? 'n/a'}`);
  lines.push(`- latest_life_state_identity_errors: ${latestCheckpoint.life_state_botland_identity_error_count ?? 'n/a'}`);
  lines.push(`- latest_action_verification: ${latestCheckpoint.action_verification_level ?? 'n/a'}/${latestCheckpoint.action_verification_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.action_verification_pass)}`);
  lines.push(`- latest_action_errors: ${latestCheckpoint.action_verification_error_count ?? 'n/a'}`);
  lines.push(`- latest_action_preflight_gate_missing: ${latestCheckpoint.action_preflight_gate_missing_count ?? 'n/a'}`);
  lines.push(`- latest_action_preflight_gate_failed: ${latestCheckpoint.action_preflight_gate_failed_count ?? 'n/a'}`);
  lines.push(`- latest_action_preflight_gate_stale: ${latestCheckpoint.action_preflight_gate_stale_count ?? 'n/a'}`);
  lines.push(`- latest_action_path_mismatches: ${latestCheckpoint.action_path_mismatch_count ?? 'n/a'}`);
  lines.push(`- latest_action_draft_reference_errors: ${latestCheckpoint.action_draft_reference_error_count ?? 'n/a'}`);
  lines.push(`- latest_action_draft_hash_mismatches: ${latestCheckpoint.action_draft_text_hash_mismatch_count ?? 'n/a'}`);
  lines.push(`- latest_run_verification: ${latestCheckpoint.run_verification_level ?? 'n/a'}/${latestCheckpoint.run_verification_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.run_verification_pass)}`);
  lines.push(`- latest_run_errors: ${latestCheckpoint.run_verification_error_count ?? 'n/a'}`);
  lines.push(`- latest_run_path_mismatches: ${latestCheckpoint.run_path_mismatch_count ?? 'n/a'}`);
  lines.push(`- latest_run_external_actions: ${latestCheckpoint.run_external_action_count ?? 'n/a'}`);
  lines.push(`- latest_run_draft_safety_errors: ${latestCheckpoint.run_draft_safety_error_count ?? 'n/a'}`);
  lines.push(`- latest_daemon_state_verification: ${latestCheckpoint.daemon_state_verification_level ?? 'n/a'}/${latestCheckpoint.daemon_state_verification_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.daemon_state_verification_pass)}`);
  lines.push(`- latest_daemon_state_errors: ${latestCheckpoint.daemon_state_verification_error_count ?? 'n/a'}`);
  lines.push(`- latest_daemon_state_run_reference_errors: ${latestCheckpoint.daemon_state_run_reference_error_count ?? 'n/a'}`);
  lines.push(`- latest_daemon_state_event_duplicates: ${latestCheckpoint.daemon_state_processed_event_duplicate_count ?? 'n/a'}`);
  lines.push(`- latest_artifact_inventory: ${latestCheckpoint.artifact_inventory_level ?? 'n/a'}/${latestCheckpoint.artifact_inventory_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.artifact_inventory_pass)}`);
  lines.push(`- latest_artifact_inventory_errors: ${latestCheckpoint.artifact_inventory_error_count ?? 'n/a'}`);
  lines.push(`- latest_artifact_unknown_files: ${latestCheckpoint.artifact_unknown_file_count ?? 'n/a'}`);
  lines.push(`- latest_artifact_non_json_files: ${latestCheckpoint.artifact_non_json_file_count ?? 'n/a'}`);
  lines.push(`- latest_systemd_units: ${latestCheckpoint.systemd_unit_verification_level ?? 'n/a'}/${latestCheckpoint.systemd_unit_verification_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.systemd_unit_verification_pass)}`);
  lines.push(`- latest_systemd_unit_errors: ${latestCheckpoint.systemd_unit_verification_error_count ?? 'n/a'}`);
  lines.push(`- latest_systemd_runtime: ${latestCheckpoint.systemd_runtime_verification_level ?? 'n/a'}/${latestCheckpoint.systemd_runtime_verification_pass === undefined ? 'n/a' : boolLabel(latestCheckpoint.systemd_runtime_verification_pass)}`);
  lines.push(`- latest_systemd_runtime_errors: ${latestCheckpoint.systemd_runtime_verification_error_count ?? 'n/a'}`);
  lines.push(`- latest_systemd_runtime_failed_services: ${latestCheckpoint.systemd_runtime_failed_service_count ?? 'n/a'}`);
  lines.push(`- latest_systemd_runtime_failed_timers: ${latestCheckpoint.systemd_runtime_failed_timer_count ?? 'n/a'}`);
  lines.push(`- latest_systemd_runtime_inactive_timers: ${latestCheckpoint.systemd_runtime_inactive_timer_count ?? 'n/a'}`);
  lines.push(`- latest_pending: ${latestCheckpoint.pending_draft_count ?? 'n/a'}`);
  lines.push(`- latest_approved: ${latestCheckpoint.approved_draft_count ?? 'n/a'}`);
  lines.push(`- latest_external_writes: ${latestCheckpoint.external_write_action_count ?? 'n/a'}`);
  lines.push(`- newest_two_change_count: ${history.newest_two_change_count ?? 'n/a'}`);
  lines.push('');
  lines.push('Systemd Runtime');
  lines.push(`- level: ${systemdRuntime.level ?? 'n/a'}/${systemdRuntime.pass === undefined ? 'n/a' : boolLabel(systemdRuntime.pass)}`);
  lines.push(`- services: ${systemdRuntime.existing_service_count ?? 0}/${systemdRuntime.service_count ?? 0}`);
  lines.push(`- timers: ${systemdRuntime.existing_timer_count ?? 0}/${systemdRuntime.timer_count ?? 0}`);
  lines.push(`- failed_services: ${systemdRuntime.failed_service_count ?? 0}`);
  lines.push(`- failed_timers: ${systemdRuntime.failed_timer_count ?? 0}`);
  lines.push(`- inactive_timers: ${systemdRuntime.inactive_timer_count ?? 0}`);
  lines.push(`- uninspected_failed_services: ${systemdRuntime.uninspected_failed_service_count ?? 0}`);
  if ((systemdRuntime.failed_units ?? []).length > 0) {
    for (const unit of systemdRuntime.failed_units) {
      lines.push(`- failed_unit: ${unit.unit_name} active=${unit.active_state ?? 'n/a'} result=${unit.result ?? 'n/a'} inspected=${boolLabel(unit.inspected)}`);
    }
  }
  lines.push('');
  lines.push('Drafts');
  lines.push(`- pending: ${health.pending_draft_count ?? 0}`);
  lines.push(`- approved: ${health.approved_draft_count ?? 0}`);
  lines.push(`- visible: ${health.visible_draft_count ?? 0}`);

  if (packet) {
    lines.push(`- latest_visible: ${packet.run_id}:${packet.draft_index}`);
    lines.push(`- draft_status: ${packet.status}`);
    lines.push(`- draft_hash: ${packet.draft?.draft_text_sha256 ?? 'unknown'}`);
    lines.push(`- ready_for_send: ${boolLabel(packet.policy_checks?.ready_for_send)}`);
    lines.push(`- approved: ${boolLabel(packet.policy_checks?.approved)}`);
    lines.push(`- approval_hash_matches: ${packet.policy_checks?.approval_hash_matches ?? 'n/a'}`);
    lines.push('');
    lines.push('Commands');
    lines.push(`- review: ${packet.commands?.refresh_packet ?? 'n/a'}`);
    lines.push(`- approve: ${packet.commands?.approve_only ?? 'n/a'}`);
    lines.push(`- dismiss: ${packet.commands?.dismiss_only ?? 'n/a'}`);
    lines.push(`- send_after_second_confirmation: ${packet.commands?.send_after_approval_and_second_confirmation ?? 'n/a'}`);
  }

  lines.push('');
  lines.push('Proposal Governance');
  lines.push(`- proposal_count: ${consoleState.proposal_governance?.proposal_count ?? 0}`);
  lines.push(`- visible: ${consoleState.proposal_governance?.visible_count ?? 0}`);
  lines.push(`- executable: ${consoleState.proposal_governance?.executable_count ?? 0}`);
  lines.push(`- manual_review: ${consoleState.proposal_governance?.review_count ?? 0}`);
  lines.push(`- by_decision: ${JSON.stringify(consoleState.proposal_governance?.counts_by_decision ?? {})}`);
  lines.push(`- by_lane: ${JSON.stringify(consoleState.proposal_governance?.counts_by_lane ?? {})}`);
  lines.push(`- dry_run_apply: ${consoleState.proposal_governance?.next_commands?.dry_run_batch_apply ?? 'n/a'}`);
  lines.push('');
  lines.push('Action Outcomes');
  lines.push(`- inspected_successful_sends: ${consoleState.action_outcomes?.inspected_successful_send_count ?? 0}`);
  lines.push(`- outcome_ledgers: ${consoleState.action_outcomes?.outcome_count ?? 0}`);
  lines.push(`- pending_outcomes: ${consoleState.action_outcomes?.pending_outcome_count ?? 0}`);
  lines.push(`- pending_action_ids: ${(consoleState.action_outcomes?.pending_action_ids ?? []).join(', ') || 'none'}`);
  lines.push(`- dry_run_scan: ${consoleState.action_outcomes?.next_command ?? 'n/a'}`);
  lines.push('');
  lines.push('Decision');
  lines.push(`- level: ${decision.level}`);
  lines.push(`- summary: ${decision.summary}`);
  lines.push(`- next_command: ${decision.next_command ?? 'none'}`);
  lines.push('');
  lines.push('read_only: yes');

  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const consoleState = buildConsole(args);
  if (args.format === 'json') {
    console.log(JSON.stringify(consoleState, null, 2));
  } else {
    process.stdout.write(formatText(consoleState));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
