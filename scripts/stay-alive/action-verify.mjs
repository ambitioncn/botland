#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const MAX_PREFLIGHT_GATE_AGE_MS = 10 * 60 * 1000;
const PREFLIGHT_GATE_CLOCK_SKEW_MS = 5 * 1000;

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 200,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
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

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/action-verify.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Number of newest action artifacts to verify. Default: 200
  --runtime-root <dir>  Runtime agents directory.
  --json                Print JSON instead of verification text.
  --help                Show this help.

This command is read-only. It verifies local draft action artifacts, including
schema shape, local-only safety markers, and required preflight_gate evidence.
It never approves drafts, dismisses drafts, or sends BotLand messages.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse();
}

function addIssue(issues, level, code, message, action = null) {
  issues.push({
    level,
    code,
    message,
    action_id: action?.action_id ?? null,
    action_path: action?.action_path ?? null
  });
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function requiresPreflight(action) {
  const id = String(action.action_id ?? '');
  return action.status === 'approved'
    || action.status === 'dismissed'
    || id.startsWith('draft_apply_')
    || id.startsWith('draft_approve_')
    || id.startsWith('draft_dismiss_')
    || Object.prototype.hasOwnProperty.call(action, 'preflight_gate');
}

function isInspectionAction(action) {
  return action.status === 'successful_send_inspected'
    || String(action.action_id ?? '').startsWith('send_inspect_');
}

function verifyPreflightGate(action, issues) {
  if (!requiresPreflight(action)) return;

  const gate = action.preflight_gate;
  if (!gate || typeof gate !== 'object') {
    addIssue(issues, 'error', 'preflight_gate_missing', 'Draft action is missing preflight_gate evidence', action);
    return;
  }

  if (gate.ok !== true || gate.pass !== true) {
    addIssue(issues, 'error', 'preflight_gate_not_pass', 'preflight_gate must have ok=true and pass=true', action);
  }
  if (gate.level === 'stop') {
    addIssue(issues, 'error', 'preflight_gate_stop_level', 'preflight_gate level must not be stop', action);
  }
  if (Array.isArray(gate.safety_findings) && gate.safety_findings.length > 0) {
    addIssue(
      issues,
      'error',
      'preflight_gate_safety_findings',
      `preflight_gate has safety findings: ${gate.safety_findings.join(', ')}`,
      action
    );
  }
  if (!isIsoDate(gate.generated_at)) {
    addIssue(issues, 'error', 'preflight_gate_generated_at_invalid', 'preflight_gate must include ISO generated_at', action);
  } else if (isIsoDate(action.created_at)) {
    const gateTime = Date.parse(gate.generated_at);
    const actionTime = Date.parse(action.created_at);
    if (gateTime - actionTime > PREFLIGHT_GATE_CLOCK_SKEW_MS) {
      addIssue(issues, 'error', 'preflight_gate_after_action', 'preflight_gate generated_at is after action created_at', action);
    }
    if (actionTime - gateTime > MAX_PREFLIGHT_GATE_AGE_MS) {
      addIssue(issues, 'error', 'preflight_gate_stale', 'preflight_gate is too old for the action timestamp', action);
    }
  }
}

function verifyActionPath(action, issues) {
  if (!action.action_id || typeof action.action_id !== 'string') return;
  if (!action.action_path || typeof action.action_path !== 'string') {
    addIssue(issues, 'error', 'action_path_missing', 'Action verification could not determine action_path', action);
    return;
  }

  const expectedFilename = `${action.action_id}.json`;
  const actualFilename = path.basename(action.action_path);
  if (actualFilename !== expectedFilename) {
    addIssue(
      issues,
      'error',
      'action_path_id_mismatch',
      `Action filename must match action_id (${expectedFilename}), got ${actualFilename}`,
      action
    );
  }
}

function compactAction(file) {
  const action = readJson(file);
  return {
    ...action,
    action_path: path.relative(WORKSPACE, file)
  };
}

function resolveRunPath(action, args) {
  const candidates = [];
  if (action.run_path && typeof action.run_path === 'string') {
    candidates.push(path.resolve(WORKSPACE, action.run_path));
  }
  if (action.run_id && typeof action.run_id === 'string') {
    candidates.push(path.join(args.runtimeRoot, args.agent, 'runs', `${action.run_id}.json`));
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? null;
}

function verifyDraftReference(action, args, issues) {
  if (!action.run_id || typeof action.run_id !== 'string') return;
  if (!Number.isInteger(action.draft_index) || action.draft_index < 0) return;

  const runPath = resolveRunPath(action, args);
  if (!runPath || !existsSync(runPath)) {
    addIssue(issues, 'error', 'run_artifact_missing', 'Referenced run artifact does not exist', action);
    return;
  }

  let run = null;
  try {
    run = readJson(runPath);
  } catch (error) {
    addIssue(
      issues,
      'error',
      'run_artifact_json_invalid',
      `Referenced run artifact is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      action
    );
    return;
  }

  if (run.run_id !== action.run_id) {
    addIssue(issues, 'error', 'run_id_reference_mismatch', 'Referenced run artifact run_id does not match action run_id', action);
  }

  const draft = Array.isArray(run.drafts) ? run.drafts[action.draft_index] : null;
  if (!draft) {
    addIssue(issues, 'error', 'draft_reference_missing', 'Referenced draft index does not exist in run artifact', action);
    return;
  }

  if (action.source_event_id && draft.source_event_id && action.source_event_id !== draft.source_event_id) {
    addIssue(issues, 'warning', 'source_event_id_mismatch', 'Action source_event_id differs from referenced draft', action);
  }
  if (action.source_message_id && draft.source_message_id && action.source_message_id !== draft.source_message_id) {
    addIssue(issues, 'warning', 'source_message_id_mismatch', 'Action source_message_id differs from referenced draft', action);
  }
  if (action.target?.citizen_id && draft.target?.citizen_id && action.target.citizen_id !== draft.target.citizen_id) {
    addIssue(issues, 'warning', 'target_citizen_id_mismatch', 'Action target citizen differs from referenced draft', action);
  }

  if (action.draft_text_sha256) {
    if (!draft.draft_text) {
      addIssue(issues, 'error', 'draft_text_missing_for_hash', 'Action has draft_text_sha256 but referenced draft has no draft_text', action);
      return;
    }

    const currentHash = sha256(draft.draft_text);
    if (action.draft_text_sha256 !== currentHash) {
      addIssue(
        issues,
        'error',
        'draft_text_hash_mismatch',
        `Action draft_text_sha256 does not match current referenced draft hash (${currentHash})`,
        action
      );
    }
  }
}

function successfulSendInspectionKey(action) {
  return [
    action.run_id ?? '',
    Number.isInteger(action.draft_index) ? String(action.draft_index) : '',
    action.inspected_action_id ?? ''
  ].join(':');
}

function buildSuccessfulSendInspectionIndex(actions) {
  const index = new Set();
  for (const action of actions) {
    if (!isInspectionAction(action)) continue;
    if (!action.inspected_action_id || typeof action.inspected_action_id !== 'string') continue;
    if (!action.run_id || !Number.isInteger(action.draft_index)) continue;
    index.add(successfulSendInspectionKey(action));
  }
  return index;
}

function verifyInspectionAction(action, actions, issues) {
  if (!isInspectionAction(action)) return;

  if (action.dry_run !== true) {
    addIssue(issues, 'error', 'inspection_not_local', 'Successful-send inspection must be dry_run=true', action);
  }
  if (action.external_write === true || action.result?.external_write !== false) {
    addIssue(issues, 'error', 'inspection_external_write', 'Successful-send inspection must be local-only with external_write=false', action);
  }
  if (!action.inspected_action_id || typeof action.inspected_action_id !== 'string') {
    addIssue(issues, 'error', 'inspection_target_missing', 'Successful-send inspection must include inspected_action_id', action);
    return;
  }

  const inspected = actions.find((candidate) => candidate.action_id === action.inspected_action_id);
  if (!inspected) {
    addIssue(issues, 'error', 'inspection_target_not_found', 'Inspected send action artifact was not found', action);
    return;
  }
  if (inspected.run_id !== action.run_id || inspected.draft_index !== action.draft_index) {
    addIssue(issues, 'error', 'inspection_target_draft_mismatch', 'Inspection target must reference the same run_id and draft_index', action);
  }
  if (inspected.dry_run !== false || inspected.result?.ok !== true) {
    addIssue(issues, 'error', 'inspection_target_not_successful_send', 'Inspection target must be a successful send action', action);
  }
  if (isIsoDate(inspected.created_at) && isIsoDate(action.created_at) && Date.parse(action.created_at) < Date.parse(inspected.created_at)) {
    addIssue(issues, 'error', 'inspection_before_send', 'Inspection cannot be created before the inspected send action', action);
  }
}

function verifyAction(action, args, issues, context) {
  if (!action.action_id || typeof action.action_id !== 'string') {
    addIssue(issues, 'error', 'action_id_missing', 'Action must include string action_id', action);
  }
  if (!isIsoDate(action.created_at)) {
    addIssue(issues, 'error', 'created_at_invalid', 'Action must include ISO created_at', action);
  }
  if (action.agent_id !== args.agent) {
    addIssue(issues, 'error', 'agent_id_mismatch', `Action agent_id must equal ${args.agent}`, action);
  }
  if (!action.run_id || typeof action.run_id !== 'string') {
    addIssue(issues, 'error', 'run_id_missing', 'Action must include string run_id', action);
  }
  const isIntentionAction = typeof action.action_intention_id === 'string'
    || String(action.action_id ?? '').startsWith('action_apply_');
  if ((!Number.isInteger(action.draft_index) || action.draft_index < 0) && !isIntentionAction) {
    addIssue(issues, 'error', 'draft_index_invalid', 'Legacy draft action must include non-negative integer draft_index', action);
  }
  if (isIntentionAction && (!action.action_intention_id || typeof action.action_intention_id !== 'string')) {
    addIssue(issues, 'error', 'action_intention_id_missing', 'Intention action must include action_intention_id', action);
  }
  if (action.tool_supervision_decision?.schema && action.tool_supervision_decision.schema !== 'stay_alive.tool_supervision_decision.v1') {
    addIssue(issues, 'error', 'tool_supervision_decision_schema_invalid', 'tool_supervision_decision schema must be stay_alive.tool_supervision_decision.v1', action);
  }
  if (action.external_write === true) {
    addIssue(issues, 'error', 'external_write_action', 'Action artifact is marked external_write=true', action);
  }
  if (!action.result || typeof action.result !== 'object') {
    addIssue(issues, 'warning', 'result_missing', 'Action should include result object', action);
  }
  if (action.status === 'approved' && !action.draft_text_sha256) {
    addIssue(issues, 'error', 'approval_hash_missing', 'Approved action must include draft_text_sha256', action);
  }
  if (action.status === 'approved' && action.result?.external_write !== false) {
    addIssue(issues, 'error', 'approval_result_not_local', 'Approved action result must be external_write=false', action);
  }
  if (action.status === 'dismissed' && action.result?.external_write !== false) {
    addIssue(issues, 'error', 'dismissal_result_not_local', 'Dismissed action result must be external_write=false', action);
  }
  if (action.dry_run === false && action.result?.ok === true) {
    const inspected = context.successfulSendInspectionIndex.has(successfulSendInspectionKey({
      ...action,
      inspected_action_id: action.action_id
    }));
    if (!inspected) {
      addIssue(issues, 'error', 'successful_send_uninspected', 'Successful send action requires explicit operator inspection', action);
    }
  }
  verifyInspectionAction(action, context.actions, issues);

  verifyPreflightGate(action, issues);
  verifyActionPath(action, issues);
  verifyDraftReference(action, args, issues);
}

function buildReport(args) {
  const actionsDir = path.join(args.runtimeRoot, args.agent, 'actions');
  const allFiles = listJsonFiles(actionsDir);
  const files = allFiles.slice(0, args.limit);
  const issues = [];
  const actions = [];

  if (!existsSync(actionsDir)) {
    addIssue(issues, 'warning', 'actions_dir_missing', `No actions directory found: ${actionsDir}`);
  }

  for (const file of files) {
    try {
      const action = compactAction(file);
      actions.push(action);
    } catch (error) {
      addIssue(
        issues,
        'error',
        'action_json_invalid',
        `${path.relative(WORKSPACE, file)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const context = {
    actions,
    successfulSendInspectionIndex: buildSuccessfulSendInspectionIndex(actions)
  };

  for (const action of actions) {
    verifyAction(action, args, issues, context);
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  const missingPreflight = issues.filter((issue) => issue.code === 'preflight_gate_missing');
  const preflightFailed = issues.filter((issue) => issue.code.startsWith('preflight_gate_') && issue.code !== 'preflight_gate_missing');
  const stalePreflight = issues.filter((issue) => issue.code === 'preflight_gate_stale');
  const actionPathMismatches = issues.filter((issue) => issue.code === 'action_path_id_mismatch' || issue.code === 'action_path_missing');
  const draftReferenceErrors = issues.filter((issue) => issue.code.startsWith('run_') || issue.code.startsWith('draft_'));
  const draftHashMismatches = issues.filter((issue) => issue.code === 'draft_text_hash_mismatch');
  const uninspectedSuccessfulSendActions = issues.filter((issue) => issue.code === 'successful_send_uninspected');
  const inspectionErrors = issues.filter((issue) => issue.code.startsWith('inspection_'));
  const externalWriteActions = issues.filter((issue) => issue.code === 'external_write_action');
  const inspectionActions = actions.filter(isInspectionAction);

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    actions_dir: actionsDir,
    window: {
      requested_limit: args.limit,
      action_count: actions.length,
      total_action_files: allFiles.length
    },
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    preflight_gate_missing_count: missingPreflight.length,
    preflight_gate_failed_count: preflightFailed.length,
    preflight_gate_stale_count: stalePreflight.length,
    action_path_mismatch_count: actionPathMismatches.length,
    draft_reference_error_count: draftReferenceErrors.filter((issue) => issue.level === 'error').length,
    draft_text_hash_mismatch_count: draftHashMismatches.length,
    uninspected_successful_send_count: uninspectedSuccessfulSendActions.length,
    successful_send_inspection_count: inspectionActions.length,
    inspection_error_count: inspectionErrors.filter((issue) => issue.level === 'error').length,
    external_write_action_count: externalWriteActions.length,
    errors,
    warnings,
    actions: actions.map((action) => ({
      action_id: action.action_id ?? null,
      action_path: action.action_path,
      created_at: action.created_at ?? null,
      status: action.status ?? null,
      dry_run: action.dry_run ?? null,
      run_id: action.run_id ?? null,
      draft_index: Number.isInteger(action.draft_index) ? action.draft_index : null,
      preflight_gate_present: Boolean(action.preflight_gate),
      preflight_gate_pass: action.preflight_gate?.pass ?? null,
      preflight_gate_generated_at: action.preflight_gate?.generated_at ?? null,
      draft_text_sha256_present: Boolean(action.draft_text_sha256),
      external_write: action.external_write === true,
      result_ok: action.result?.ok ?? null
    }))
  };
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive action verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${report.read_only ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${report.pass ? 'yes' : 'no'}`);
  lines.push(`- errors: ${report.error_count}`);
  lines.push(`- warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('Actions');
  lines.push(`- action_count: ${report.window.action_count}`);
  lines.push(`- total_action_files: ${report.window.total_action_files}`);
  lines.push(`- preflight_gate_missing_count: ${report.preflight_gate_missing_count}`);
  lines.push(`- preflight_gate_failed_count: ${report.preflight_gate_failed_count}`);
  lines.push(`- preflight_gate_stale_count: ${report.preflight_gate_stale_count}`);
  lines.push(`- action_path_mismatch_count: ${report.action_path_mismatch_count}`);
  lines.push(`- draft_reference_error_count: ${report.draft_reference_error_count}`);
  lines.push(`- draft_text_hash_mismatch_count: ${report.draft_text_hash_mismatch_count}`);
  lines.push(`- uninspected_successful_send_count: ${report.uninspected_successful_send_count}`);
  lines.push(`- successful_send_inspection_count: ${report.successful_send_inspection_count}`);
  lines.push(`- inspection_error_count: ${report.inspection_error_count}`);
  lines.push(`- external_write_action_count: ${report.external_write_action_count}`);

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) {
      lines.push(`- ${issue.code}: ${issue.action_id ?? 'n/a'} ${issue.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) {
      lines.push(`- ${issue.code}: ${issue.action_id ?? 'n/a'} ${issue.message}`);
    }
  }

  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');

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
