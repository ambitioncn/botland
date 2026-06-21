#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 50,
    draftLimit: null,
    verifyLimit: 20,
    historyLimit: 3,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    checkpointDir: null,
    createCheckpoint: true,
    requireBotlandLive: false,
    allowBotlandPollingFallback: false,
    strictOnboarding: false,
    includeRaw: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--draft-limit') args.draftLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--verify-limit') args.verifyLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--history-limit') args.historyLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--checkpoint-dir') args.checkpointDir = path.resolve(argv[++i]);
    else if (arg === '--no-checkpoint') args.createCheckpoint = false;
    else if (arg === '--require-botland-live') args.requireBotlandLive = true;
    else if (arg === '--allow-botland-polling-fallback') args.allowBotlandPollingFallback = true;
    else if (arg === '--strict-onboarding') args.strictOnboarding = true;
    else if (arg === '--include-raw') args.includeRaw = true;
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
    args.draftLimit = Math.max(args.limit, 300);
  }
  if (!Number.isInteger(args.draftLimit) || args.draftLimit < 1) {
    throw new Error('--draft-limit must be a positive integer');
  }
  if (!Number.isInteger(args.verifyLimit) || args.verifyLimit < 1) {
    throw new Error('--verify-limit must be a positive integer');
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
  console.log(`Usage: node scripts/stay-alive/preflight.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --limit <n>              Recent run/audit window. Default: 50
  --draft-limit <n>        Recent run window for draft lookup. Default: max(limit, 300)
  --verify-limit <n>       Number of checkpoints to verify. Default: 20
  --history-limit <n>      Number of checkpoints to summarize. Default: 3
  --runtime-root <dir>     Runtime agents directory.
  --checkpoint-dir <dir>   Directory for checkpoint artifacts.
  --no-checkpoint          Do not create a new local checkpoint before verification.
  --require-botland-live   Treat BotLand CLI/identity/daemon health issues as hard errors.
  --allow-botland-polling-fallback
                          Let durable events polling degrade daemon WS health drift to review.
  --strict-onboarding      Do not allow historical run/action/checkpoint artifacts in onboarding verification.
  --include-raw            Include full embedded status/operator/audit/verify payloads in JSON.
  --json                   Print JSON instead of preflight text.
  --help                   Show this help.

This command is the operator preflight gate. It composes status, operator console,
audit report, control audit, checkpoint, checkpoint history, and checkpoint verification.
It never approves drafts, dismisses drafts, or sends BotLand messages. By default
it writes only one local checkpoint artifact for traceability.
`);
}

function runtimeRootArgs(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function checkpointDirArgs(args) {
  return ['--checkpoint-dir', args.checkpointDir];
}

function runJson(script, scriptArgs, options = {}) {
  const result = spawnSync(process.execPath, [
    script,
    ...scriptArgs,
    ...(options.addJsonFlag ? ['--json'] : [])
  ], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${script}): ${stderr || stdout || `exit ${result.status}`}`);
  }

  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Could not parse JSON from ${script}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    status: result.status ?? 0,
    ok: result.status === 0,
    stdout,
    stderr,
    parsed
  };
}

function buildPreflight(args) {
  const runtimeArgs = runtimeRootArgs(args);
  const statusArgs = [
    '--agent',
    args.agent,
    '--limit',
    String(args.limit),
    '--draft-limit',
    String(args.draftLimit),
    ...runtimeArgs
  ];
  const auditArgs = [
    '--agent',
    args.agent,
    '--limit',
    String(args.limit),
    '--draft-limit',
    String(args.draftLimit),
    '--history-limit',
    String(args.historyLimit),
    ...runtimeArgs,
    ...checkpointDirArgs(args)
  ];
  const checkpointArgs = [
    '--agent',
    args.agent,
    '--limit',
    String(args.limit),
    ...runtimeArgs,
    ...checkpointDirArgs(args)
  ];
  const verifyArgs = [
    '--agent',
    args.agent,
    '--limit',
    String(args.verifyLimit),
    ...runtimeArgs,
    ...checkpointDirArgs(args)
  ];
  const historyArgs = [
    '--agent',
    args.agent,
    '--limit',
    String(args.historyLimit),
    '--compare',
    ...runtimeArgs,
    ...checkpointDirArgs(args)
  ];
  const controlAuditArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs
  ];
  const verificationWindow = String(Math.max(args.draftLimit, 200));
  const actionVerifyArgs = [
    '--agent',
    args.agent,
    '--limit',
    verificationWindow,
    ...runtimeArgs
  ];
  const lifeStateVerifyArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs
  ];
  const runVerifyArgs = [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeArgs
  ];
  const draftStateVerifyArgs = [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeArgs
  ];
  const proposalStateVerifyArgs = [
    '--agent',
    args.agent,
    '--limit',
    '200',
    ...runtimeArgs
  ];
  const daemonStateVerifyArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs
  ];
  const onboardingVerifyArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs
  ];
  if (!args.strictOnboarding) {
    onboardingVerifyArgs.splice(2, 0, '--allow-historical-runtime');
  }
  const artifactInventoryArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs
  ];
  const runtimeStorageVerificationArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs
  ];
  const systemdUnitVerificationArgs = [
    '--agent',
    args.agent,
    '--workspace',
    WORKSPACE
  ];
  const systemdRuntimeVerificationArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs
  ];
  const botlandBridgeVerificationArgs = [
    '--agent',
    args.agent,
    ...runtimeArgs,
    ...(args.requireBotlandLive ? ['--require-live'] : []),
    ...(args.allowBotlandPollingFallback ? ['--allow-polling-fallback'] : [])
  ];

  const status = runJson('scripts/stay-alive/status.mjs', statusArgs).parsed;
  const operator = runJson('scripts/stay-alive/operator-console.mjs', statusArgs, { addJsonFlag: true }).parsed;
  const audit = runJson(
    'scripts/stay-alive/audit-report.mjs',
    auditArgs,
    { addJsonFlag: true, allowFailure: true }
  ).parsed;
  const controlAuditRun = runJson(
    'scripts/stay-alive/control-audit.mjs',
    controlAuditArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const controlAudit = controlAuditRun.parsed;
  const lifeStateVerificationRun = runJson(
    'scripts/stay-alive/life-state-verify.mjs',
    lifeStateVerifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const lifeStateVerification = lifeStateVerificationRun.parsed;
  const actionVerificationRun = runJson(
    'scripts/stay-alive/action-verify.mjs',
    actionVerifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const actionVerification = actionVerificationRun.parsed;
  const runVerificationRun = runJson(
    'scripts/stay-alive/run-verify.mjs',
    runVerifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const runVerification = runVerificationRun.parsed;
  const draftStateVerificationRun = runJson(
    'scripts/stay-alive/draft-state-verify.mjs',
    draftStateVerifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const draftStateVerification = draftStateVerificationRun.parsed;
  const proposalStateVerificationRun = runJson(
    'scripts/stay-alive/proposal-state-verify.mjs',
    proposalStateVerifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const proposalStateVerification = proposalStateVerificationRun.parsed;
  const daemonStateVerificationRun = runJson(
    'scripts/stay-alive/daemon-state-verify.mjs',
    daemonStateVerifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const daemonStateVerification = daemonStateVerificationRun.parsed;
  const onboardingVerificationRun = runJson(
    'scripts/stay-alive/onboarding-verify.mjs',
    onboardingVerifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const onboardingVerification = onboardingVerificationRun.parsed;
  const artifactInventoryRun = runJson(
    'scripts/stay-alive/artifact-inventory.mjs',
    artifactInventoryArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const artifactInventory = artifactInventoryRun.parsed;
  const runtimeStorageVerificationRun = runJson(
    'scripts/stay-alive/runtime-storage-verify.mjs',
    runtimeStorageVerificationArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const runtimeStorageVerification = runtimeStorageVerificationRun.parsed;
  const systemdUnitVerificationRun = runJson(
    'scripts/stay-alive/systemd-unit-verify.mjs',
    systemdUnitVerificationArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const systemdUnitVerification = systemdUnitVerificationRun.parsed;
  const systemdRuntimeVerificationRun = runJson(
    'scripts/stay-alive/systemd-runtime-verify.mjs',
    systemdRuntimeVerificationArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const systemdRuntimeVerification = systemdRuntimeVerificationRun.parsed;
  const botlandBridgeVerificationRun = runJson(
    'scripts/stay-alive/botland-bridge-verify.mjs',
    botlandBridgeVerificationArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const botlandBridgeVerification = botlandBridgeVerificationRun.parsed;
  const checkpoint = args.createCheckpoint
    ? runJson('scripts/stay-alive/checkpoint.mjs', checkpointArgs, { addJsonFlag: true }).parsed
    : null;
  const checkpointHistory = runJson(
    'scripts/stay-alive/checkpoint-list.mjs',
    historyArgs,
    { addJsonFlag: true }
  ).parsed;
  const verificationRun = runJson(
    'scripts/stay-alive/checkpoint-verify.mjs',
    verifyArgs,
    { addJsonFlag: true, allowFailure: true }
  );
  const verification = verificationRun.parsed;

  const safetyFindings = [];
  const health = status.health ?? {};
  const control = status.control_state ?? {};
  const actionAudit = audit.action_audit ?? {};
  const runAudit = audit.run_audit ?? {};
  const checkpointAudit = audit.checkpoint_audit ?? {};
  const decision = operator.operator_decision ?? {};

  if (control.paused === true) {
    safetyFindings.push('operator_pause_active');
  }
  if ((health.external_action_count_in_window ?? 0) > 0) {
    safetyFindings.push('status_external_actions_detected');
  }
  if (audit.verdict?.pass !== true) {
    safetyFindings.push('audit_verdict_not_pass');
  }
  if ((runAudit.external_action_count ?? 0) > 0) {
    safetyFindings.push('audit_external_actions_detected');
  }
  if ((actionAudit.uninspected_successful_send_count ?? actionAudit.successful_send_count ?? 0) > 0) {
    safetyFindings.push('uninspected_successful_send_detected');
  }
  if ((actionAudit.external_write_action_count ?? 0) > 0) {
    safetyFindings.push('external_write_action_detected');
  }
  if ((checkpointAudit.checkpoint_external_evidence_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_external_evidence_detected');
  }
  if ((checkpointAudit.checkpoint_path_mismatch_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_path_mismatch_detected');
  }
  if ((checkpointAudit.checkpoint_failed_audit_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_audit_failure_detected');
  }
  if ((checkpointAudit.checkpoint_action_verification_failure_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_action_verification_failure_detected');
  }
  if ((checkpointAudit.checkpoint_draft_state_verification_failure_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_draft_state_verification_failure_detected');
  }
  if ((checkpointAudit.summary_totals?.life_state_verification_error_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_life_state_verification_failure_detected');
  }
  if ((checkpointAudit.summary_totals?.life_state_write_policy_error_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_life_state_write_policy_error_detected');
  }
  if ((checkpointAudit.summary_totals?.life_state_unattended_policy_error_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_life_state_unattended_policy_error_detected');
  }
  if ((checkpointAudit.summary_totals?.systemd_unit_verification_error_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_systemd_unit_verification_failure_detected');
  }
  if ((checkpointAudit.summary_totals?.systemd_unit_preflight_gate_error_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_systemd_unit_preflight_gate_error_detected');
  }
  if ((checkpointAudit.summary_totals?.systemd_runtime_verification_error_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_systemd_runtime_verification_failure_detected');
  }
  // Failed service state is historical systemd bookkeeping. The concrete
  // hazards that can cause a failure are checked by their own gates below.
  if ((checkpointAudit.summary_totals?.systemd_runtime_failed_timer_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_systemd_runtime_failed_timer_detected');
  }
  if ((checkpointAudit.summary_totals?.systemd_runtime_inactive_timer_count ?? 0) > 0) {
    safetyFindings.push('checkpoint_systemd_runtime_inactive_timer_detected');
  }
  if (verification?.pass !== true) {
    safetyFindings.push('checkpoint_verification_failed');
  }
  if (controlAudit?.pass !== true) {
    safetyFindings.push('control_audit_failed');
  }
  if (lifeStateVerification?.pass !== true) {
    safetyFindings.push('life_state_verification_failed');
  }
  if ((lifeStateVerification?.write_policy_error_count ?? 0) > 0) {
    safetyFindings.push('life_state_write_policy_error_detected');
  }
  if ((lifeStateVerification?.unsafe_allowed_write_type_count ?? 0) > 0) {
    safetyFindings.push('life_state_unsafe_allowed_write_type_detected');
  }
  if ((lifeStateVerification?.rate_limit_error_count ?? 0) > 0) {
    safetyFindings.push('life_state_rate_limit_error_detected');
  }
  if ((lifeStateVerification?.unattended_policy_error_count ?? 0) > 0) {
    safetyFindings.push('life_state_unattended_policy_error_detected');
  }
  if ((lifeStateVerification?.botland_identity_error_count ?? 0) > 0) {
    safetyFindings.push('life_state_botland_identity_error_detected');
  }
  if (actionVerification?.pass !== true) {
    safetyFindings.push('action_verification_failed');
  }
  if (runVerification?.pass !== true) {
    safetyFindings.push('run_verification_failed');
  }
  if (draftStateVerification?.pass !== true) {
    safetyFindings.push('draft_state_verification_failed');
  }
  if (proposalStateVerification?.pass !== true) {
    safetyFindings.push('proposal_state_verification_failed');
  }
  if ((proposalStateVerification?.reference_error_count ?? 0) > 0) {
    safetyFindings.push('proposal_state_reference_error_detected');
  }
  if ((proposalStateVerification?.duplicate_action_error_count ?? 0) > 0) {
    safetyFindings.push('proposal_state_duplicate_action_detected');
  }
  if ((proposalStateVerification?.external_write_action_count ?? 0) > 0) {
    safetyFindings.push('proposal_state_external_write_action_detected');
  }
  if ((draftStateVerification?.conflict_error_count ?? 0) > 0) {
    safetyFindings.push('draft_state_conflict_detected');
  }
  if ((draftStateVerification?.approved_hash_mismatch_count ?? 0) > 0) {
    safetyFindings.push('draft_state_approved_hash_mismatch_detected');
  }
  if ((draftStateVerification?.ready_draft_safety_error_count ?? 0) > 0) {
    safetyFindings.push('draft_state_ready_safety_error_detected');
  }
  if ((draftStateVerification?.approved_queue_overflow_count ?? 0) > 0) {
    safetyFindings.push('draft_state_approved_queue_overflow_detected');
  }
  if (daemonStateVerification?.pass !== true) {
    safetyFindings.push('daemon_state_verification_failed');
  }
  if (onboardingVerification?.pass !== true) {
    safetyFindings.push('onboarding_verification_failed');
  }
  if (artifactInventory?.pass !== true) {
    safetyFindings.push('artifact_inventory_failed');
  }
  if ((artifactInventory?.unknown_runtime_file_count ?? 0) > 0) {
    safetyFindings.push('artifact_unknown_runtime_file_detected');
  }
  if ((artifactInventory?.unknown_runtime_dir_count ?? 0) > 0) {
    safetyFindings.push('artifact_unknown_runtime_dir_detected');
  }
  if ((artifactInventory?.non_json_artifact_file_count ?? 0) > 0) {
    safetyFindings.push('artifact_non_json_file_detected');
  }
  if ((artifactInventory?.json_parse_error_count ?? 0) > 0) {
    safetyFindings.push('artifact_json_parse_error_detected');
  }
  if ((artifactInventory?.required_missing_count ?? 0) > 0) {
    safetyFindings.push('artifact_required_missing_detected');
  }
  if (runtimeStorageVerification?.pass !== true) {
    safetyFindings.push('runtime_storage_verification_failed');
  }
  if ((runtimeStorageVerification?.disk_free_error_count ?? 0) > 0) {
    safetyFindings.push('runtime_storage_disk_free_error_detected');
  }
  if ((runtimeStorageVerification?.oversized_file_count ?? 0) > 0) {
    safetyFindings.push('runtime_storage_oversized_file_detected');
  }
  if (systemdUnitVerification?.pass !== true) {
    safetyFindings.push('systemd_unit_verification_failed');
  }
  if ((systemdUnitVerification?.preflight_gate_error_count ?? 0) > 0) {
    safetyFindings.push('systemd_unit_preflight_gate_error_detected');
  }
  if ((systemdUnitVerification?.runner_safety_error_count ?? 0) > 0) {
    safetyFindings.push('systemd_unit_runner_safety_error_detected');
  }
  if ((systemdUnitVerification?.timer_schedule_error_count ?? 0) > 0) {
    safetyFindings.push('systemd_unit_timer_schedule_error_detected');
  }
  if (systemdRuntimeVerification?.pass !== true) {
    safetyFindings.push('systemd_runtime_verification_failed');
  }
  // A stale failed service must not block later cycles. Service recovery
  // records inspection/reset artifacts, while preflight keeps blocking only on
  // concrete safety hazards such as uninspected sends or timer drift.
  if ((systemdRuntimeVerification?.failed_timer_count ?? 0) > 0) {
    safetyFindings.push('systemd_runtime_failed_timer_detected');
  }
  if ((systemdRuntimeVerification?.inactive_timer_count ?? 0) > 0) {
    safetyFindings.push('systemd_runtime_inactive_timer_detected');
  }
  if ((systemdRuntimeVerification?.disabled_timer_count ?? 0) > 0) {
    safetyFindings.push('systemd_runtime_disabled_timer_detected');
  }
  if (botlandBridgeVerification?.pass !== true) {
    safetyFindings.push('botland_bridge_verification_failed');
  }
  if (args.requireBotlandLive && (botlandBridgeVerification?.identity_mismatch_count ?? 0) > 0) {
    safetyFindings.push('botland_bridge_identity_mismatch_detected');
  }
  if (args.requireBotlandLive && (botlandBridgeVerification?.cli_version_error_count ?? 0) > 0) {
    safetyFindings.push('botland_bridge_cli_version_error_detected');
  }
  if (args.requireBotlandLive && (botlandBridgeVerification?.daemon_health_error_count ?? 0) > 0) {
    safetyFindings.push('botland_bridge_daemon_health_error_detected');
  }
  if (args.requireBotlandLive && (botlandBridgeVerification?.websocket_disconnected_count ?? 0) > 0) {
    safetyFindings.push('botland_bridge_websocket_disconnected_detected');
  }
  if ((daemonStateVerification?.run_reference_error_count ?? 0) > 0) {
    safetyFindings.push('daemon_state_run_reference_error_detected');
  }
  if ((daemonStateVerification?.processed_event_duplicate_count ?? 0) > 0) {
    safetyFindings.push('daemon_state_processed_event_duplicate_detected');
  }
  if ((runVerification?.run_path_mismatch_count ?? 0) > 0) {
    safetyFindings.push('run_path_mismatch_detected');
  }
  if ((runVerification?.external_action_run_count ?? 0) > 0) {
    safetyFindings.push('run_external_action_detected');
  }
  if ((runVerification?.draft_safety_error_count ?? 0) > 0) {
    safetyFindings.push('run_draft_safety_error_detected');
  }
  if (decision.level === 'stop') {
    safetyFindings.push('operator_stop');
  }

  const safetyPass = safetyFindings.length === 0;
  const latestNeedsAttention = Boolean(health.latest_run_needs_attention);
  const reviewNeeded = Boolean((health.pending_draft_count ?? 0) > 0 || (health.approved_draft_count ?? 0) > 0);

  return {
    read_only_except_checkpoint: args.createCheckpoint,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    require_botland_live: args.requireBotlandLive,
    allow_botland_polling_fallback: args.allowBotlandPollingFallback,
    checkpoint_created: checkpoint
      ? {
          checkpoint_id: checkpoint.checkpoint_id,
          checkpoint_path: checkpoint.checkpoint_path,
          generated_at: checkpoint.generated_at,
          summary: checkpoint.summary
        }
      : null,
    verdict: {
      pass: safetyPass,
      level: safetyPass
        ? (latestNeedsAttention ? 'attention' : reviewNeeded ? 'review' : 'ok')
        : 'stop',
      safety_findings: safetyFindings,
      summary: safetyPass
        ? 'No external write evidence found in status, audit, or checkpoints.'
        : 'External write or checkpoint safety evidence requires inspection before continuing.'
    },
    status: {
      ok: health.ok ?? null,
      latest_run_id: status.latest_run?.run_id ?? null,
      latest_run_needs_attention: latestNeedsAttention,
      pending_draft_count: health.pending_draft_count ?? 0,
      approved_draft_count: health.approved_draft_count ?? 0,
      visible_draft_count: health.visible_draft_count ?? 0,
      draft_run_window: health.draft_run_window ?? args.draftLimit,
      external_action_count_in_window: health.external_action_count_in_window ?? 0
    },
    control: {
      paused: control.paused === true,
      paused_raw: control.paused_raw === true,
      paused_at: control.paused_at ?? null,
      paused_by: control.paused_by ?? null,
      pause_reason: control.pause_reason ?? null,
      pause_until: control.pause_until ?? null,
      pause_expired: control.pause_expired === true,
      resumed_at: control.resumed_at ?? null
    },
    control_audit: controlAudit
      ? {
          pass: controlAudit.pass,
          level: controlAudit.level,
          error_count: controlAudit.errors?.length ?? 0,
          warning_count: controlAudit.warnings?.length ?? 0,
          warnings: controlAudit.warnings ?? [],
          suggested_next_command: controlAudit.suggested_next_command ?? null
        }
      : null,
    life_state_verification: lifeStateVerification
      ? {
          pass: lifeStateVerification.pass,
          level: lifeStateVerification.level,
          error_count: lifeStateVerification.error_count ?? 0,
          warning_count: lifeStateVerification.warning_count ?? 0,
          missing: lifeStateVerification.missing === true,
          write_policy_error_count: lifeStateVerification.write_policy_error_count ?? 0,
          unsafe_allowed_write_type_count: lifeStateVerification.unsafe_allowed_write_type_count ?? 0,
          writes_enabled_count: lifeStateVerification.writes_enabled_count ?? 0,
          unattended_policy_error_count: lifeStateVerification.unattended_policy_error_count ?? 0,
          unattended_policy_enabled_count: lifeStateVerification.unattended_policy_enabled_count ?? 0,
          rate_limit_error_count: lifeStateVerification.rate_limit_error_count ?? 0,
          botland_identity_error_count: lifeStateVerification.botland_identity_error_count ?? 0
        }
      : null,
    action_verification: actionVerification
      ? {
          pass: actionVerification.pass,
          level: actionVerification.level,
          action_count: actionVerification.window?.action_count ?? 0,
          error_count: actionVerification.error_count ?? 0,
          warning_count: actionVerification.warning_count ?? 0,
          preflight_gate_missing_count: actionVerification.preflight_gate_missing_count ?? 0,
          preflight_gate_failed_count: actionVerification.preflight_gate_failed_count ?? 0,
          preflight_gate_stale_count: actionVerification.preflight_gate_stale_count ?? 0,
          action_path_mismatch_count: actionVerification.action_path_mismatch_count ?? 0,
          draft_reference_error_count: actionVerification.draft_reference_error_count ?? 0,
          draft_text_hash_mismatch_count: actionVerification.draft_text_hash_mismatch_count ?? 0,
          uninspected_successful_send_count: actionVerification.uninspected_successful_send_count ?? 0,
          successful_send_inspection_count: actionVerification.successful_send_inspection_count ?? 0,
          inspection_error_count: actionVerification.inspection_error_count ?? 0,
          external_write_action_count: actionVerification.external_write_action_count ?? 0
        }
      : null,
    run_verification: runVerification
      ? {
          pass: runVerification.pass,
          level: runVerification.level,
          run_count: runVerification.window?.run_count ?? 0,
          error_count: runVerification.error_count ?? 0,
          warning_count: runVerification.warning_count ?? 0,
          run_path_mismatch_count: runVerification.run_path_mismatch_count ?? 0,
          external_action_run_count: runVerification.external_action_run_count ?? 0,
          draft_safety_error_count: runVerification.draft_safety_error_count ?? 0
        }
      : null,
    draft_state_verification: draftStateVerification
      ? {
          pass: draftStateVerification.pass,
          level: draftStateVerification.level,
          draft_count: draftStateVerification.window?.draft_count ?? 0,
          action_count: draftStateVerification.window?.action_count ?? 0,
          error_count: draftStateVerification.error_count ?? 0,
          warning_count: draftStateVerification.warning_count ?? 0,
          conflict_error_count: draftStateVerification.conflict_error_count ?? 0,
          approved_hash_mismatch_count: draftStateVerification.approved_hash_mismatch_count ?? 0,
          ready_draft_safety_error_count: draftStateVerification.ready_draft_safety_error_count ?? 0,
          approved_queue_overflow_count: draftStateVerification.approved_queue_overflow_count ?? 0,
          counts: draftStateVerification.counts ?? null
        }
      : null,
    proposal_state_verification: proposalStateVerification
      ? {
          pass: proposalStateVerification.pass,
          level: proposalStateVerification.level,
          proposal_count: proposalStateVerification.proposal_count ?? 0,
          action_count: proposalStateVerification.action_count ?? 0,
          approved_count: proposalStateVerification.approved_count ?? 0,
          applied_count: proposalStateVerification.applied_count ?? 0,
          error_count: proposalStateVerification.error_count ?? 0,
          warning_count: proposalStateVerification.warning_count ?? 0,
          reference_error_count: proposalStateVerification.reference_error_count ?? 0,
          duplicate_action_error_count: proposalStateVerification.duplicate_action_error_count ?? 0,
          external_write_action_count: proposalStateVerification.external_write_action_count ?? 0
        }
      : null,
    daemon_state_verification: daemonStateVerification
      ? {
          pass: daemonStateVerification.pass,
          level: daemonStateVerification.level,
          error_count: daemonStateVerification.error_count ?? 0,
          warning_count: daemonStateVerification.warning_count ?? 0,
          missing: daemonStateVerification.missing === true,
          last_run_missing_count: daemonStateVerification.last_run_missing_count ?? 0,
          last_run_not_latest_count: daemonStateVerification.last_run_not_latest_count ?? 0,
          run_reference_error_count: daemonStateVerification.run_reference_error_count ?? 0,
          processed_event_duplicate_count: daemonStateVerification.processed_event_duplicate_count ?? 0
        }
      : null,
    onboarding_verification: onboardingVerification
      ? {
          pass: onboardingVerification.pass,
          level: onboardingVerification.level,
          error_count: onboardingVerification.error_count ?? 0,
          warning_count: onboardingVerification.warning_count ?? 0,
          onboarding_present: onboardingVerification.onboarding_present === true,
          onboarding_mode: onboardingVerification.onboarding_mode ?? null,
          source_agent_id: onboardingVerification.source_agent_id ?? null,
          historical_artifact_count: onboardingVerification.historical_artifact_count ?? 0,
          strict: args.strictOnboarding
        }
      : null,
    artifact_inventory: artifactInventory
      ? {
          pass: artifactInventory.pass,
          level: artifactInventory.level,
          error_count: artifactInventory.error_count ?? 0,
          warning_count: artifactInventory.warning_count ?? 0,
          unknown_runtime_file_count: artifactInventory.unknown_runtime_file_count ?? 0,
          unknown_runtime_dir_count: artifactInventory.unknown_runtime_dir_count ?? 0,
          non_json_artifact_file_count: artifactInventory.non_json_artifact_file_count ?? 0,
          unexpected_subdir_count: artifactInventory.unexpected_subdir_count ?? 0,
          json_parse_error_count: artifactInventory.json_parse_error_count ?? 0,
          required_missing_count: artifactInventory.required_missing_count ?? 0,
          directory_counts: artifactInventory.directory_counts ?? null
        }
      : null,
    runtime_storage_verification: runtimeStorageVerification
      ? {
          pass: runtimeStorageVerification.pass,
          level: runtimeStorageVerification.level,
          error_count: runtimeStorageVerification.error_count ?? 0,
          warning_count: runtimeStorageVerification.warning_count ?? 0,
          disk_available_mb: runtimeStorageVerification.disk?.available_mb ?? null,
          disk_available_percent: runtimeStorageVerification.disk?.available_percent ?? null,
          runtime_total_mb: runtimeStorageVerification.runtime?.total_mb ?? null,
          runtime_file_count: runtimeStorageVerification.runtime?.file_count ?? 0,
          disk_free_error_count: runtimeStorageVerification.disk_free_error_count ?? 0,
          oversized_file_count: runtimeStorageVerification.oversized_file_count ?? 0,
          runtime_size_warning_count: runtimeStorageVerification.runtime_size_warning_count ?? 0
        }
      : null,
    systemd_unit_verification: systemdUnitVerification
      ? {
          pass: systemdUnitVerification.pass,
          level: systemdUnitVerification.level,
          error_count: systemdUnitVerification.error_count ?? 0,
          warning_count: systemdUnitVerification.warning_count ?? 0,
          service_count: systemdUnitVerification.service_count ?? 0,
          timer_count: systemdUnitVerification.timer_count ?? 0,
          existing_service_count: systemdUnitVerification.existing_service_count ?? 0,
          existing_timer_count: systemdUnitVerification.existing_timer_count ?? 0,
          missing_service_count: systemdUnitVerification.missing_service_count ?? 0,
          missing_timer_count: systemdUnitVerification.missing_timer_count ?? 0,
          preflight_gate_error_count: systemdUnitVerification.preflight_gate_error_count ?? 0,
          runner_safety_error_count: systemdUnitVerification.runner_safety_error_count ?? 0,
          timer_schedule_error_count: systemdUnitVerification.timer_schedule_error_count ?? 0
        }
      : null,
    systemd_runtime_verification: systemdRuntimeVerification
      ? {
          pass: systemdRuntimeVerification.pass,
          level: systemdRuntimeVerification.level,
          error_count: systemdRuntimeVerification.error_count ?? 0,
          warning_count: systemdRuntimeVerification.warning_count ?? 0,
          service_count: systemdRuntimeVerification.service_count ?? 0,
          timer_count: systemdRuntimeVerification.timer_count ?? 0,
          existing_service_count: systemdRuntimeVerification.existing_service_count ?? 0,
          existing_timer_count: systemdRuntimeVerification.existing_timer_count ?? 0,
          missing_service_count: systemdRuntimeVerification.missing_service_count ?? 0,
          missing_timer_count: systemdRuntimeVerification.missing_timer_count ?? 0,
          failed_service_count: systemdRuntimeVerification.failed_service_count ?? 0,
          uninspected_failed_service_count: systemdRuntimeVerification.uninspected_failed_service_count ?? 0,
          inspected_failed_service_count: systemdRuntimeVerification.inspected_failed_service_count ?? 0,
          service_failure_inspection_count: systemdRuntimeVerification.service_failure_inspection_count ?? 0,
          service_failure_recovery_count: systemdRuntimeVerification.service_failure_recovery_count ?? 0,
          failed_timer_count: systemdRuntimeVerification.failed_timer_count ?? 0,
          inactive_timer_count: systemdRuntimeVerification.inactive_timer_count ?? 0,
          disabled_timer_count: systemdRuntimeVerification.disabled_timer_count ?? 0,
          next_elapse_missing_count: systemdRuntimeVerification.next_elapse_missing_count ?? 0
        }
      : null,
    botland_bridge_verification: botlandBridgeVerification
      ? {
          pass: botlandBridgeVerification.pass,
          level: botlandBridgeVerification.level,
          require_live: botlandBridgeVerification.require_live === true,
          allow_polling_fallback: botlandBridgeVerification.allow_polling_fallback === true,
          polling_fallback_available: botlandBridgeVerification.polling_fallback?.available === true,
          error_count: botlandBridgeVerification.error_count ?? 0,
          warning_count: botlandBridgeVerification.warning_count ?? 0,
          cli_version: botlandBridgeVerification.cli_version ?? null,
          expected_citizen_id: botlandBridgeVerification.expected_citizen_id ?? null,
          whoami_citizen_id: botlandBridgeVerification.whoami?.citizen_id ?? null,
          daemon_healthy: botlandBridgeVerification.daemon_health?.healthy === true,
          websocket_connected: botlandBridgeVerification.daemon_health?.websocket_connected === true,
          identity_mismatch_count: botlandBridgeVerification.identity_mismatch_count ?? 0,
          cli_version_error_count: botlandBridgeVerification.cli_version_error_count ?? 0,
          daemon_health_error_count: botlandBridgeVerification.daemon_health_error_count ?? 0,
          websocket_disconnected_count: botlandBridgeVerification.websocket_disconnected_count ?? 0,
          polling_fallback_warning_count: botlandBridgeVerification.polling_fallback_warning_count ?? 0
        }
      : null,
    operator_decision: decision,
    audit: {
      pass: audit.verdict?.pass ?? null,
      level: audit.verdict?.level ?? null,
      external_action_count: runAudit.external_action_count ?? 0,
      action_count: actionAudit.action_count ?? 0,
      successful_send_count: actionAudit.successful_send_count ?? 0,
      inspected_successful_send_count: actionAudit.inspected_successful_send_count ?? 0,
      uninspected_successful_send_count: actionAudit.uninspected_successful_send_count ?? 0,
      successful_send_inspection_count: actionAudit.successful_send_inspection_count ?? 0,
      external_write_action_count: actionAudit.external_write_action_count ?? 0,
      approved_count: actionAudit.approved_count ?? 0,
      dismissed_count: actionAudit.dismissed_count ?? 0,
      checkpoint_count: checkpointAudit.checkpoint_count ?? 0,
      checkpoint_path_mismatch_count: checkpointAudit.checkpoint_path_mismatch_count ?? 0,
      checkpoint_external_evidence_count: checkpointAudit.checkpoint_external_evidence_count ?? 0,
      checkpoint_failed_audit_count: checkpointAudit.checkpoint_failed_audit_count ?? 0,
      checkpoint_action_verification_failure_count: checkpointAudit.checkpoint_action_verification_failure_count ?? 0,
      checkpoint_draft_state_verification_failure_count: checkpointAudit.checkpoint_draft_state_verification_failure_count ?? 0,
      checkpoint_summary_totals: checkpointAudit.summary_totals ?? {
        external_action_count_in_window: 0,
        successful_send_count: 0,
        inspected_successful_send_count: 0,
        uninspected_successful_send_count: 0,
        successful_send_inspection_count: 0,
        external_write_action_count: 0,
        action_verification_error_count: 0,
        life_state_verification_error_count: 0,
        life_state_write_policy_error_count: 0,
        life_state_unsafe_allowed_write_type_count: 0,
        life_state_writes_enabled_count: 0,
        life_state_rate_limit_error_count: 0,
        life_state_botland_identity_error_count: 0,
        action_preflight_gate_missing_count: 0,
        action_preflight_gate_failed_count: 0,
        action_preflight_gate_stale_count: 0,
        action_path_mismatch_count: 0,
        action_draft_reference_error_count: 0,
        action_draft_text_hash_mismatch_count: 0,
        draft_state_verification_error_count: 0,
        draft_state_conflict_error_count: 0,
        draft_state_approved_hash_mismatch_count: 0,
        draft_state_ready_safety_error_count: 0,
        run_verification_error_count: 0,
        run_path_mismatch_count: 0,
        run_external_action_count: 0,
        run_draft_safety_error_count: 0,
        daemon_state_verification_error_count: 0,
        daemon_state_run_reference_error_count: 0,
        daemon_state_processed_event_duplicate_count: 0,
        artifact_inventory_error_count: 0,
        artifact_unknown_file_count: 0,
        artifact_unknown_dir_count: 0,
        artifact_non_json_file_count: 0,
        artifact_json_parse_error_count: 0,
        runtime_storage_verification_error_count: 0,
        runtime_storage_disk_free_error_count: 0,
        runtime_storage_oversized_file_count: 0,
        systemd_unit_verification_error_count: 0,
        systemd_unit_preflight_gate_error_count: 0,
        systemd_unit_runner_safety_error_count: 0,
        systemd_unit_timer_schedule_error_count: 0,
        systemd_runtime_verification_error_count: 0,
        systemd_runtime_failed_service_count: 0,
        systemd_runtime_uninspected_failed_service_count: 0,
        systemd_runtime_inspected_failed_service_count: 0,
        service_failure_inspection_count: 0,
        service_failure_recovery_count: 0,
        systemd_runtime_failed_timer_count: 0,
        systemd_runtime_inactive_timer_count: 0,
        systemd_runtime_disabled_timer_count: 0
      },
      checkpoint_latest_checkpoint_id: checkpointAudit.latest_checkpoint_id ?? null
    },
    checkpoint_verification: verification
      ? {
          pass: verification.pass,
      checkpoint_count: verification.checkpoint_count,
          checkpoint_path_mismatch_count: verification.checkpoint_path_mismatch_count ?? 0,
          error_count: verification.error_count,
          warning_count: verification.warning_count
        }
      : null,
    checkpoint_history: checkpointHistory
      ? {
          checkpoint_count: checkpointHistory.checkpoint_count,
          checkpoint_path_mismatch_count: checkpointHistory.checkpoint_path_mismatch_count ?? 0,
          latest_checkpoint_id: checkpointHistory.checkpoints?.[0]?.checkpoint_id ?? null,
          latest_generated_at: checkpointHistory.checkpoints?.[0]?.generated_at ?? null,
          latest_summary: checkpointHistory.checkpoints?.[0]?.summary ?? null,
          newest_two_change_count: checkpointHistory.compare_newest_two?.change_count ?? null,
          newest_two_changes: checkpointHistory.compare_newest_two?.changes ?? []
        }
      : null,
    ...(args.includeRaw
      ? {
          raw: {
            status,
            operator_console: operator,
            audit_report: audit,
            control_audit: controlAudit,
            life_state_verification: lifeStateVerification,
            action_verification: actionVerification,
            draft_state_verification: draftStateVerification,
            proposal_state_verification: proposalStateVerification,
            run_verification: runVerification,
            daemon_state_verification: daemonStateVerification,
            artifact_inventory: artifactInventory,
            runtime_storage_verification: runtimeStorageVerification,
            systemd_unit_verification: systemdUnitVerification,
            systemd_runtime_verification: systemdRuntimeVerification,
            botland_bridge_verification: botlandBridgeVerification,
            checkpoint_history: checkpointHistory,
            checkpoint_verification: verification
          }
        }
      : {})
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive preflight (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`checkpoint_created: ${report.checkpoint_created?.checkpoint_id ?? 'no'}`);
  if (report.checkpoint_created?.checkpoint_path) {
    lines.push(`checkpoint_path: ${report.checkpoint_created.checkpoint_path}`);
  }
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.verdict.level}`);
  lines.push(`- pass: ${boolLabel(report.verdict.pass)}`);
  lines.push(`- summary: ${report.verdict.summary}`);
  lines.push(`- safety_findings: ${report.verdict.safety_findings.length > 0 ? report.verdict.safety_findings.join(', ') : 'none'}`);
  lines.push('');
  lines.push('Status');
  lines.push(`- ok: ${boolLabel(report.status.ok)}`);
  lines.push(`- latest_run: ${report.status.latest_run_id ?? 'none'}`);
  lines.push(`- latest_run_needs_attention: ${boolLabel(report.status.latest_run_needs_attention)}`);
  lines.push(`- drafts: pending=${report.status.pending_draft_count} approved=${report.status.approved_draft_count} visible=${report.status.visible_draft_count}`);
  lines.push(`- draft_run_window: ${report.status.draft_run_window}`);
  lines.push(`- external_action_count_in_window: ${report.status.external_action_count_in_window}`);
  lines.push('');
  lines.push('Control');
  lines.push(`- paused: ${boolLabel(report.control.paused)}`);
  lines.push(`- paused_raw: ${boolLabel(report.control.paused_raw)}`);
  lines.push(`- paused_at: ${report.control.paused_at ?? 'none'}`);
  lines.push(`- pause_reason: ${report.control.pause_reason ?? 'none'}`);
  lines.push(`- pause_until: ${report.control.pause_until ?? 'none'}`);
  lines.push(`- pause_expired: ${boolLabel(report.control.pause_expired)}`);
  lines.push(`- audit_level: ${report.control_audit?.level ?? 'unknown'}`);
  lines.push(`- audit_errors: ${report.control_audit?.error_count ?? 0}`);
  lines.push(`- audit_warnings: ${report.control_audit?.warning_count ?? 0}`);
  lines.push('');
  lines.push('Life State Verification');
  lines.push(`- pass: ${boolLabel(report.life_state_verification?.pass)}`);
  lines.push(`- level: ${report.life_state_verification?.level ?? 'unknown'}`);
  lines.push(`- errors: ${report.life_state_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.life_state_verification?.warning_count ?? 0}`);
  lines.push(`- missing: ${boolLabel(report.life_state_verification?.missing)}`);
  lines.push(`- write_policy_error_count: ${report.life_state_verification?.write_policy_error_count ?? 0}`);
  lines.push(`- unsafe_allowed_write_type_count: ${report.life_state_verification?.unsafe_allowed_write_type_count ?? 0}`);
  lines.push(`- writes_enabled_count: ${report.life_state_verification?.writes_enabled_count ?? 0}`);
  lines.push(`- unattended_policy_error_count: ${report.life_state_verification?.unattended_policy_error_count ?? 0}`);
  lines.push(`- unattended_policy_enabled_count: ${report.life_state_verification?.unattended_policy_enabled_count ?? 0}`);
  lines.push(`- rate_limit_error_count: ${report.life_state_verification?.rate_limit_error_count ?? 0}`);
  lines.push(`- botland_identity_error_count: ${report.life_state_verification?.botland_identity_error_count ?? 0}`);
  lines.push('');
  lines.push('Audit');
  lines.push(`- pass: ${boolLabel(report.audit.pass)}`);
  lines.push(`- level: ${report.audit.level ?? 'unknown'}`);
  lines.push(`- action_count: ${report.audit.action_count}`);
  lines.push(`- successful_send_count: ${report.audit.successful_send_count}`);
  lines.push(`- inspected_successful_send_count: ${report.audit.inspected_successful_send_count}`);
  lines.push(`- uninspected_successful_send_count: ${report.audit.uninspected_successful_send_count}`);
  lines.push(`- successful_send_inspection_count: ${report.audit.successful_send_inspection_count}`);
  lines.push(`- external_write_action_count: ${report.audit.external_write_action_count}`);
  lines.push(`- checkpoint_count: ${report.audit.checkpoint_count}`);
  lines.push(`- checkpoint_path_mismatch_count: ${report.audit.checkpoint_path_mismatch_count}`);
  lines.push(`- checkpoint_external_evidence_count: ${report.audit.checkpoint_external_evidence_count}`);
  lines.push(`- checkpoint_failed_audit_count: ${report.audit.checkpoint_failed_audit_count}`);
  lines.push(`- checkpoint_action_verification_failure_count: ${report.audit.checkpoint_action_verification_failure_count}`);
  lines.push(`- checkpoint_draft_state_verification_failure_count: ${report.audit.checkpoint_draft_state_verification_failure_count}`);
  lines.push(`- checkpoint_summary_external_actions: ${report.audit.checkpoint_summary_totals.external_action_count_in_window}`);
  lines.push(`- checkpoint_summary_successful_sends: ${report.audit.checkpoint_summary_totals.successful_send_count}`);
  lines.push(`- checkpoint_summary_inspected_successful_sends: ${report.audit.checkpoint_summary_totals.inspected_successful_send_count}`);
  lines.push(`- checkpoint_summary_uninspected_successful_sends: ${report.audit.checkpoint_summary_totals.uninspected_successful_send_count}`);
  lines.push(`- checkpoint_summary_successful_send_inspections: ${report.audit.checkpoint_summary_totals.successful_send_inspection_count}`);
  lines.push(`- checkpoint_summary_external_write_actions: ${report.audit.checkpoint_summary_totals.external_write_action_count}`);
  lines.push(`- checkpoint_summary_action_verification_errors: ${report.audit.checkpoint_summary_totals.action_verification_error_count}`);
  lines.push(`- checkpoint_summary_life_state_errors: ${report.audit.checkpoint_summary_totals.life_state_verification_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_life_state_policy_errors: ${report.audit.checkpoint_summary_totals.life_state_write_policy_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_life_state_unsafe_writes: ${report.audit.checkpoint_summary_totals.life_state_unsafe_allowed_write_type_count ?? 0}`);
  lines.push(`- checkpoint_summary_life_state_writes_enabled: ${report.audit.checkpoint_summary_totals.life_state_writes_enabled_count ?? 0}`);
  lines.push(`- checkpoint_summary_life_state_rate_errors: ${report.audit.checkpoint_summary_totals.life_state_rate_limit_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_life_state_identity_errors: ${report.audit.checkpoint_summary_totals.life_state_botland_identity_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_action_preflight_gate_missing: ${report.audit.checkpoint_summary_totals.action_preflight_gate_missing_count}`);
  lines.push(`- checkpoint_summary_action_preflight_gate_failed: ${report.audit.checkpoint_summary_totals.action_preflight_gate_failed_count}`);
  lines.push(`- checkpoint_summary_action_preflight_gate_stale: ${report.audit.checkpoint_summary_totals.action_preflight_gate_stale_count}`);
  lines.push(`- checkpoint_summary_action_path_mismatches: ${report.audit.checkpoint_summary_totals.action_path_mismatch_count}`);
  lines.push(`- checkpoint_summary_action_draft_reference_errors: ${report.audit.checkpoint_summary_totals.action_draft_reference_error_count}`);
  lines.push(`- checkpoint_summary_action_draft_hash_mismatches: ${report.audit.checkpoint_summary_totals.action_draft_text_hash_mismatch_count}`);
  lines.push(`- checkpoint_summary_draft_state_errors: ${report.audit.checkpoint_summary_totals.draft_state_verification_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_draft_state_conflicts: ${report.audit.checkpoint_summary_totals.draft_state_conflict_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_draft_state_hash_mismatches: ${report.audit.checkpoint_summary_totals.draft_state_approved_hash_mismatch_count ?? 0}`);
  lines.push(`- checkpoint_summary_run_verification_errors: ${report.audit.checkpoint_summary_totals.run_verification_error_count}`);
  lines.push(`- checkpoint_summary_run_path_mismatches: ${report.audit.checkpoint_summary_totals.run_path_mismatch_count}`);
  lines.push(`- checkpoint_summary_run_external_actions: ${report.audit.checkpoint_summary_totals.run_external_action_count}`);
  lines.push(`- checkpoint_summary_run_draft_safety_errors: ${report.audit.checkpoint_summary_totals.run_draft_safety_error_count}`);
  lines.push(`- checkpoint_summary_daemon_state_errors: ${report.audit.checkpoint_summary_totals.daemon_state_verification_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_daemon_state_run_reference_errors: ${report.audit.checkpoint_summary_totals.daemon_state_run_reference_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_artifact_inventory_errors: ${report.audit.checkpoint_summary_totals.artifact_inventory_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_artifact_unknown_files: ${report.audit.checkpoint_summary_totals.artifact_unknown_file_count ?? 0}`);
  lines.push(`- checkpoint_summary_artifact_unknown_dirs: ${report.audit.checkpoint_summary_totals.artifact_unknown_dir_count ?? 0}`);
  lines.push(`- checkpoint_summary_artifact_non_json_files: ${report.audit.checkpoint_summary_totals.artifact_non_json_file_count ?? 0}`);
  lines.push(`- checkpoint_summary_artifact_json_parse_errors: ${report.audit.checkpoint_summary_totals.artifact_json_parse_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_runtime_storage_errors: ${report.audit.checkpoint_summary_totals.runtime_storage_verification_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_runtime_storage_disk_free_errors: ${report.audit.checkpoint_summary_totals.runtime_storage_disk_free_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_runtime_storage_oversized_files: ${report.audit.checkpoint_summary_totals.runtime_storage_oversized_file_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_unit_errors: ${report.audit.checkpoint_summary_totals.systemd_unit_verification_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_preflight_gate_errors: ${report.audit.checkpoint_summary_totals.systemd_unit_preflight_gate_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_runner_safety_errors: ${report.audit.checkpoint_summary_totals.systemd_unit_runner_safety_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_timer_schedule_errors: ${report.audit.checkpoint_summary_totals.systemd_unit_timer_schedule_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_runtime_errors: ${report.audit.checkpoint_summary_totals.systemd_runtime_verification_error_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_runtime_failed_services: ${report.audit.checkpoint_summary_totals.systemd_runtime_failed_service_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_runtime_failed_timers: ${report.audit.checkpoint_summary_totals.systemd_runtime_failed_timer_count ?? 0}`);
  lines.push(`- checkpoint_summary_systemd_runtime_inactive_timers: ${report.audit.checkpoint_summary_totals.systemd_runtime_inactive_timer_count ?? 0}`);
  lines.push('');
  lines.push('Action Verification');
  lines.push(`- pass: ${boolLabel(report.action_verification?.pass)}`);
  lines.push(`- level: ${report.action_verification?.level ?? 'unknown'}`);
  lines.push(`- action_count: ${report.action_verification?.action_count ?? 0}`);
  lines.push(`- errors: ${report.action_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.action_verification?.warning_count ?? 0}`);
  lines.push(`- preflight_gate_missing_count: ${report.action_verification?.preflight_gate_missing_count ?? 0}`);
  lines.push(`- preflight_gate_failed_count: ${report.action_verification?.preflight_gate_failed_count ?? 0}`);
  lines.push(`- preflight_gate_stale_count: ${report.action_verification?.preflight_gate_stale_count ?? 0}`);
  lines.push(`- action_path_mismatch_count: ${report.action_verification?.action_path_mismatch_count ?? 0}`);
  lines.push(`- draft_reference_error_count: ${report.action_verification?.draft_reference_error_count ?? 0}`);
  lines.push(`- draft_text_hash_mismatch_count: ${report.action_verification?.draft_text_hash_mismatch_count ?? 0}`);
  lines.push('');
  lines.push('Draft State Verification');
  lines.push(`- pass: ${boolLabel(report.draft_state_verification?.pass)}`);
  lines.push(`- level: ${report.draft_state_verification?.level ?? 'unknown'}`);
  lines.push(`- draft_count: ${report.draft_state_verification?.draft_count ?? 0}`);
  lines.push(`- action_count: ${report.draft_state_verification?.action_count ?? 0}`);
  lines.push(`- errors: ${report.draft_state_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.draft_state_verification?.warning_count ?? 0}`);
  lines.push(`- conflict_error_count: ${report.draft_state_verification?.conflict_error_count ?? 0}`);
  lines.push(`- approved_hash_mismatch_count: ${report.draft_state_verification?.approved_hash_mismatch_count ?? 0}`);
  lines.push(`- ready_draft_safety_error_count: ${report.draft_state_verification?.ready_draft_safety_error_count ?? 0}`);
  lines.push(`- approved_queue_overflow_count: ${report.draft_state_verification?.approved_queue_overflow_count ?? 0}`);
  lines.push('');
  lines.push('Run Verification');
  lines.push(`- pass: ${boolLabel(report.run_verification?.pass)}`);
  lines.push(`- level: ${report.run_verification?.level ?? 'unknown'}`);
  lines.push(`- run_count: ${report.run_verification?.run_count ?? 0}`);
  lines.push(`- errors: ${report.run_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.run_verification?.warning_count ?? 0}`);
  lines.push(`- run_path_mismatch_count: ${report.run_verification?.run_path_mismatch_count ?? 0}`);
  lines.push(`- external_action_run_count: ${report.run_verification?.external_action_run_count ?? 0}`);
  lines.push(`- draft_safety_error_count: ${report.run_verification?.draft_safety_error_count ?? 0}`);
  lines.push('');
  lines.push('Daemon State Verification');
  lines.push(`- pass: ${boolLabel(report.daemon_state_verification?.pass)}`);
  lines.push(`- level: ${report.daemon_state_verification?.level ?? 'unknown'}`);
  lines.push(`- errors: ${report.daemon_state_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.daemon_state_verification?.warning_count ?? 0}`);
  lines.push(`- missing: ${boolLabel(report.daemon_state_verification?.missing)}`);
  lines.push(`- last_run_missing_count: ${report.daemon_state_verification?.last_run_missing_count ?? 0}`);
  lines.push(`- last_run_not_latest_count: ${report.daemon_state_verification?.last_run_not_latest_count ?? 0}`);
  lines.push(`- run_reference_error_count: ${report.daemon_state_verification?.run_reference_error_count ?? 0}`);
  lines.push(`- processed_event_duplicate_count: ${report.daemon_state_verification?.processed_event_duplicate_count ?? 0}`);
  lines.push('');
  lines.push('Onboarding Verification');
  lines.push(`- pass: ${boolLabel(report.onboarding_verification?.pass)}`);
  lines.push(`- level: ${report.onboarding_verification?.level ?? 'unknown'}`);
  lines.push(`- strict: ${boolLabel(report.onboarding_verification?.strict)}`);
  lines.push(`- errors: ${report.onboarding_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.onboarding_verification?.warning_count ?? 0}`);
  lines.push(`- onboarding_present: ${boolLabel(report.onboarding_verification?.onboarding_present)}`);
  lines.push(`- onboarding_mode: ${report.onboarding_verification?.onboarding_mode ?? 'unknown'}`);
  lines.push(`- source_agent_id: ${report.onboarding_verification?.source_agent_id ?? 'none'}`);
  lines.push(`- historical_artifact_count: ${report.onboarding_verification?.historical_artifact_count ?? 0}`);
  lines.push('');
  lines.push('Artifact Inventory');
  lines.push(`- pass: ${boolLabel(report.artifact_inventory?.pass)}`);
  lines.push(`- level: ${report.artifact_inventory?.level ?? 'unknown'}`);
  lines.push(`- errors: ${report.artifact_inventory?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.artifact_inventory?.warning_count ?? 0}`);
  lines.push(`- unknown_runtime_file_count: ${report.artifact_inventory?.unknown_runtime_file_count ?? 0}`);
  lines.push(`- unknown_runtime_dir_count: ${report.artifact_inventory?.unknown_runtime_dir_count ?? 0}`);
  lines.push(`- non_json_artifact_file_count: ${report.artifact_inventory?.non_json_artifact_file_count ?? 0}`);
  lines.push(`- unexpected_subdir_count: ${report.artifact_inventory?.unexpected_subdir_count ?? 0}`);
  lines.push(`- json_parse_error_count: ${report.artifact_inventory?.json_parse_error_count ?? 0}`);
  lines.push(`- required_missing_count: ${report.artifact_inventory?.required_missing_count ?? 0}`);
  lines.push('');
  lines.push('Runtime Storage Verification');
  lines.push(`- pass: ${boolLabel(report.runtime_storage_verification?.pass)}`);
  lines.push(`- level: ${report.runtime_storage_verification?.level ?? 'unknown'}`);
  lines.push(`- errors: ${report.runtime_storage_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.runtime_storage_verification?.warning_count ?? 0}`);
  lines.push(`- disk_available_mb: ${report.runtime_storage_verification?.disk_available_mb ?? 'unknown'}`);
  lines.push(`- disk_available_percent: ${report.runtime_storage_verification?.disk_available_percent ?? 'unknown'}`);
  lines.push(`- runtime_total_mb: ${report.runtime_storage_verification?.runtime_total_mb ?? 'unknown'}`);
  lines.push(`- runtime_file_count: ${report.runtime_storage_verification?.runtime_file_count ?? 0}`);
  lines.push(`- disk_free_error_count: ${report.runtime_storage_verification?.disk_free_error_count ?? 0}`);
  lines.push(`- oversized_file_count: ${report.runtime_storage_verification?.oversized_file_count ?? 0}`);
  lines.push(`- runtime_size_warning_count: ${report.runtime_storage_verification?.runtime_size_warning_count ?? 0}`);
  lines.push('');
  lines.push('Systemd Unit Verification');
  lines.push(`- pass: ${boolLabel(report.systemd_unit_verification?.pass)}`);
  lines.push(`- level: ${report.systemd_unit_verification?.level ?? 'unknown'}`);
  lines.push(`- errors: ${report.systemd_unit_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.systemd_unit_verification?.warning_count ?? 0}`);
  lines.push(`- existing_services: ${report.systemd_unit_verification?.existing_service_count ?? 0}/${report.systemd_unit_verification?.service_count ?? 0}`);
  lines.push(`- existing_timers: ${report.systemd_unit_verification?.existing_timer_count ?? 0}/${report.systemd_unit_verification?.timer_count ?? 0}`);
  lines.push(`- missing_services: ${report.systemd_unit_verification?.missing_service_count ?? 0}`);
  lines.push(`- missing_timers: ${report.systemd_unit_verification?.missing_timer_count ?? 0}`);
  lines.push(`- preflight_gate_errors: ${report.systemd_unit_verification?.preflight_gate_error_count ?? 0}`);
  lines.push(`- runner_safety_errors: ${report.systemd_unit_verification?.runner_safety_error_count ?? 0}`);
  lines.push(`- timer_schedule_errors: ${report.systemd_unit_verification?.timer_schedule_error_count ?? 0}`);
  lines.push('');
  lines.push('Systemd Runtime Verification');
  lines.push(`- pass: ${boolLabel(report.systemd_runtime_verification?.pass)}`);
  lines.push(`- level: ${report.systemd_runtime_verification?.level ?? 'unknown'}`);
  lines.push(`- errors: ${report.systemd_runtime_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.systemd_runtime_verification?.warning_count ?? 0}`);
  lines.push(`- existing_services: ${report.systemd_runtime_verification?.existing_service_count ?? 0}/${report.systemd_runtime_verification?.service_count ?? 0}`);
  lines.push(`- existing_timers: ${report.systemd_runtime_verification?.existing_timer_count ?? 0}/${report.systemd_runtime_verification?.timer_count ?? 0}`);
  lines.push(`- missing_services: ${report.systemd_runtime_verification?.missing_service_count ?? 0}`);
  lines.push(`- missing_timers: ${report.systemd_runtime_verification?.missing_timer_count ?? 0}`);
  lines.push(`- failed_services: ${report.systemd_runtime_verification?.failed_service_count ?? 0}`);
  lines.push(`- failed_timers: ${report.systemd_runtime_verification?.failed_timer_count ?? 0}`);
  lines.push(`- inactive_timers: ${report.systemd_runtime_verification?.inactive_timer_count ?? 0}`);
  lines.push(`- disabled_timers: ${report.systemd_runtime_verification?.disabled_timer_count ?? 0}`);
  lines.push('');
  lines.push('BotLand Bridge Verification');
  lines.push(`- pass: ${boolLabel(report.botland_bridge_verification?.pass)}`);
  lines.push(`- level: ${report.botland_bridge_verification?.level ?? 'unknown'}`);
  lines.push(`- require_live: ${boolLabel(report.botland_bridge_verification?.require_live)}`);
  lines.push(`- allow_polling_fallback: ${boolLabel(report.botland_bridge_verification?.allow_polling_fallback)}`);
  lines.push(`- polling_fallback_available: ${boolLabel(report.botland_bridge_verification?.polling_fallback_available)}`);
  lines.push(`- errors: ${report.botland_bridge_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.botland_bridge_verification?.warning_count ?? 0}`);
  lines.push(`- cli_version: ${report.botland_bridge_verification?.cli_version ?? 'unknown'}`);
  lines.push(`- whoami_citizen_id: ${report.botland_bridge_verification?.whoami_citizen_id ?? 'unknown'}`);
  lines.push(`- daemon_healthy: ${boolLabel(report.botland_bridge_verification?.daemon_healthy)}`);
  lines.push(`- websocket_connected: ${boolLabel(report.botland_bridge_verification?.websocket_connected)}`);
  lines.push(`- identity_mismatch_count: ${report.botland_bridge_verification?.identity_mismatch_count ?? 0}`);
  lines.push(`- cli_version_error_count: ${report.botland_bridge_verification?.cli_version_error_count ?? 0}`);
  lines.push(`- daemon_health_error_count: ${report.botland_bridge_verification?.daemon_health_error_count ?? 0}`);
  lines.push(`- websocket_disconnected_count: ${report.botland_bridge_verification?.websocket_disconnected_count ?? 0}`);
  lines.push(`- polling_fallback_warnings: ${report.botland_bridge_verification?.polling_fallback_warning_count ?? 0}`);
  lines.push('');
  lines.push('Checkpoint Verification');
  lines.push(`- pass: ${boolLabel(report.checkpoint_verification?.pass)}`);
  lines.push(`- checkpoint_count: ${report.checkpoint_verification?.checkpoint_count ?? 0}`);
  lines.push(`- checkpoint_path_mismatch_count: ${report.checkpoint_verification?.checkpoint_path_mismatch_count ?? 0}`);
  lines.push(`- errors: ${report.checkpoint_verification?.error_count ?? 0}`);
  lines.push(`- warnings: ${report.checkpoint_verification?.warning_count ?? 0}`);
  lines.push('');
  lines.push('Checkpoint History');
  lines.push(`- checkpoint_count: ${report.checkpoint_history?.checkpoint_count ?? 0}`);
  lines.push(`- checkpoint_path_mismatch_count: ${report.checkpoint_history?.checkpoint_path_mismatch_count ?? 0}`);
  lines.push(`- latest_checkpoint: ${report.checkpoint_history?.latest_checkpoint_id ?? 'none'}`);
  lines.push(`- latest_generated_at: ${report.checkpoint_history?.latest_generated_at ?? 'none'}`);
  lines.push(`- newest_two_change_count: ${report.checkpoint_history?.newest_two_change_count ?? 'n/a'}`);
  const latestSummary = report.checkpoint_history?.latest_summary ?? {};
  lines.push(`- latest_control: ${latestSummary.control_audit_level ?? 'n/a'}/${latestSummary.control_audit_pass === undefined ? 'n/a' : boolLabel(latestSummary.control_audit_pass)}`);
  lines.push(`- latest_actions: ${latestSummary.action_verification_level ?? 'n/a'}/${latestSummary.action_verification_pass === undefined ? 'n/a' : boolLabel(latestSummary.action_verification_pass)} errors=${latestSummary.action_verification_error_count ?? 'n/a'} missing_gate=${latestSummary.action_preflight_gate_missing_count ?? 'n/a'} failed_gate=${latestSummary.action_preflight_gate_failed_count ?? 'n/a'} stale_gate=${latestSummary.action_preflight_gate_stale_count ?? 'n/a'} path_mismatch=${latestSummary.action_path_mismatch_count ?? 'n/a'} draft_refs=${latestSummary.action_draft_reference_error_count ?? 'n/a'} hash_mismatch=${latestSummary.action_draft_text_hash_mismatch_count ?? 'n/a'}`);
  lines.push(`- latest_runs: ${latestSummary.run_verification_level ?? 'n/a'}/${latestSummary.run_verification_pass === undefined ? 'n/a' : boolLabel(latestSummary.run_verification_pass)} errors=${latestSummary.run_verification_error_count ?? 'n/a'} path_mismatch=${latestSummary.run_path_mismatch_count ?? 'n/a'} external_actions=${latestSummary.run_external_action_count ?? 'n/a'} draft_safety=${latestSummary.run_draft_safety_error_count ?? 'n/a'}`);
  lines.push(`- latest_daemon_state: ${latestSummary.daemon_state_verification_level ?? 'n/a'}/${latestSummary.daemon_state_verification_pass === undefined ? 'n/a' : boolLabel(latestSummary.daemon_state_verification_pass)} errors=${latestSummary.daemon_state_verification_error_count ?? 'n/a'} run_refs=${latestSummary.daemon_state_run_reference_error_count ?? 'n/a'} duplicates=${latestSummary.daemon_state_processed_event_duplicate_count ?? 'n/a'}`);
  lines.push(`- latest_artifacts: ${latestSummary.artifact_inventory_level ?? 'n/a'}/${latestSummary.artifact_inventory_pass === undefined ? 'n/a' : boolLabel(latestSummary.artifact_inventory_pass)} errors=${latestSummary.artifact_inventory_error_count ?? 'n/a'} unknown_files=${latestSummary.artifact_unknown_file_count ?? 'n/a'} non_json=${latestSummary.artifact_non_json_file_count ?? 'n/a'} parse_errors=${latestSummary.artifact_json_parse_error_count ?? 'n/a'}`);
  lines.push(`- latest_systemd_runtime: ${latestSummary.systemd_runtime_verification_level ?? 'n/a'}/${latestSummary.systemd_runtime_verification_pass === undefined ? 'n/a' : boolLabel(latestSummary.systemd_runtime_verification_pass)} errors=${latestSummary.systemd_runtime_verification_error_count ?? 'n/a'} failed_services=${latestSummary.systemd_runtime_failed_service_count ?? 'n/a'} failed_timers=${latestSummary.systemd_runtime_failed_timer_count ?? 'n/a'} inactive_timers=${latestSummary.systemd_runtime_inactive_timer_count ?? 'n/a'} disabled_timers=${latestSummary.systemd_runtime_disabled_timer_count ?? 'n/a'}`);
  lines.push(`- latest_drafts: pending=${latestSummary.pending_draft_count ?? 0} approved=${latestSummary.approved_draft_count ?? 0} visible=${latestSummary.visible_draft_count ?? 0}`);
  lines.push(`- latest_external_writes: actions=${latestSummary.external_action_count_in_window ?? 0} sends=${latestSummary.successful_send_count ?? 0} uninspected_sends=${latestSummary.uninspected_successful_send_count ?? 0} external_write_actions=${latestSummary.external_write_action_count ?? 0}`);
  lines.push('');
  lines.push('Operator');
  lines.push(`- decision: ${report.operator_decision?.level ?? 'unknown'}`);
  lines.push(`- next_command: ${report.operator_decision?.next_command ?? 'none'}`);
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');

  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildPreflight(args);
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatText(report));
  }
  process.exit(report.verdict.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
