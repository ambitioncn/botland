#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

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
  console.log(`Usage: node scripts/stay-alive/run-verify.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Number of newest run artifacts to verify. Default: 200
  --runtime-root <dir>  Runtime agents directory.
  --json                Print JSON instead of verification text.
  --help                Show this help.

This command is read-only. It verifies local run artifacts, including filename/id
integrity, basic schema shape, dry-run safety markers, and external action
evidence. It never approves drafts, dismisses drafts, or sends BotLand messages.
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

function addIssue(issues, level, code, message, run = null) {
  issues.push({
    level,
    code,
    message,
    run_id: run?.run_id ?? null,
    run_path: run?.run_path ?? null
  });
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function compactRun(file) {
  const run = readJson(file);
  return {
    ...run,
    run_path: path.relative(WORKSPACE, file)
  };
}

function verifyRunPath(run, issues) {
  if (!run.run_id || typeof run.run_id !== 'string') return;
  if (!run.run_path || typeof run.run_path !== 'string') {
    addIssue(issues, 'error', 'run_path_missing', 'Run verification could not determine run_path', run);
    return;
  }

  const expectedFilename = `${run.run_id}.json`;
  const actualFilename = path.basename(run.run_path);
  if (actualFilename !== expectedFilename) {
    addIssue(
      issues,
      'error',
      'run_path_id_mismatch',
      `Run filename must match run_id (${expectedFilename}), got ${actualFilename}`,
      run
    );
  }
}

function verifyDrafts(run, issues) {
  const drafts = Array.isArray(run.drafts) ? run.drafts : [];
  drafts.forEach((draft, index) => {
    const context = { ...run, run_id: `${run.run_id}:draft:${index}` };
    if (draft.external_write === true) {
      addIssue(issues, 'error', 'draft_external_write', 'Draft must not be marked external_write=true', context);
    }
    if (draft.requires_confirmation !== true) {
      addIssue(issues, 'error', 'draft_confirmation_missing', 'Draft must require confirmation', context);
    }
    if (draft.ready_for_send === true && typeof draft.draft_text !== 'string') {
      addIssue(issues, 'error', 'ready_draft_text_missing', 'Ready draft must include draft_text', context);
    }
  });
}

function verifyActionPlanner(run, issues) {
  if (run.action_candidates === undefined && run.action_selection === undefined) return;
  if (!Array.isArray(run.action_candidates)) {
    addIssue(issues, 'error', 'action_candidates_invalid', 'Run action_candidates must be an array when action planner output is present', run);
    return;
  }
  if (!run.action_selection || typeof run.action_selection !== 'object') {
    addIssue(issues, 'error', 'action_selection_missing', 'Run action_selection must be present when action_candidates are recorded', run);
    return;
  }
  if (run.action_candidates.length === 0) {
    addIssue(issues, 'error', 'action_candidates_empty', 'Run action_candidates must include at least a no_op candidate', run);
  }

  const ids = new Set();
  for (const candidate of run.action_candidates) {
    if (!candidate || typeof candidate !== 'object') {
      addIssue(issues, 'error', 'action_candidate_invalid', 'Action candidate must be an object', run);
      continue;
    }
    if (!candidate.candidate_id || typeof candidate.candidate_id !== 'string') {
      addIssue(issues, 'error', 'action_candidate_id_missing', 'Action candidate must include candidate_id', run);
    } else if (ids.has(candidate.candidate_id)) {
      addIssue(issues, 'error', 'action_candidate_id_duplicate', 'Action candidate ids must be unique inside one run', run);
    } else {
      ids.add(candidate.candidate_id);
    }
    if (candidate.external_write === true) {
      addIssue(issues, 'error', 'action_candidate_external_write', 'Action candidates must not mark external_write=true in v0', run);
    }
    if (!Number.isFinite(candidate.score)) {
      addIssue(issues, 'warning', 'action_candidate_score_missing', 'Action candidate should include numeric score', run);
    }
  }

  const selectedId = run.action_selection.selected_candidate_id;
  if (selectedId && !ids.has(selectedId)) {
    addIssue(issues, 'error', 'action_selection_candidate_missing', 'Selected action candidate id is not present in action_candidates', run);
  }
  if (run.chosen_action?.candidate_id && selectedId && run.chosen_action.candidate_id !== selectedId) {
    addIssue(issues, 'error', 'chosen_action_candidate_mismatch', 'chosen_action candidate_id must match action_selection selected_candidate_id', run);
  }
}

function verifyActionIntentions(run, issues) {
  if (run.action_intentions === undefined) return;
  if (!Array.isArray(run.action_intentions)) {
    addIssue(issues, 'error', 'action_intentions_invalid', 'Run action_intentions must be an array when present', run);
    return;
  }
  const drafts = Array.isArray(run.drafts) ? run.drafts : [];
  const ids = new Set();
  for (const intention of run.action_intentions) {
    if (!intention || typeof intention !== 'object') {
      addIssue(issues, 'error', 'action_intention_invalid', 'Action intention must be an object', run);
      continue;
    }
    if (intention.schema !== 'stay_alive.action_intention.v1') {
      addIssue(issues, 'error', 'action_intention_schema_invalid', 'Action intention schema must be stay_alive.action_intention.v1', run);
    }
    if (!intention.intention_id || typeof intention.intention_id !== 'string') {
      addIssue(issues, 'error', 'action_intention_id_missing', 'Action intention must include intention_id', run);
    } else if (ids.has(intention.intention_id)) {
      addIssue(issues, 'error', 'action_intention_id_duplicate', 'Action intention ids must be unique inside one run', run);
    } else {
      ids.add(intention.intention_id);
    }
    const legacyDraftIndex = intention.legacy_draft_index ?? intention.draft_index;
    if (Number.isInteger(legacyDraftIndex) && !drafts[legacyDraftIndex]) {
      addIssue(issues, 'error', 'action_intention_draft_missing', 'Action intention legacy draft reference must point at an existing draft', run);
    }
    if (!intention.proposed_action || typeof intention.proposed_action !== 'object') {
      const hasLegacyDraftMirror = Number.isInteger(legacyDraftIndex) && Boolean(drafts[legacyDraftIndex]);
      addIssue(
        issues,
        hasLegacyDraftMirror ? 'warning' : 'error',
        hasLegacyDraftMirror ? 'legacy_action_intention_proposed_action_missing' : 'action_intention_proposed_action_missing',
        hasLegacyDraftMirror
          ? 'Legacy action intention is missing proposed_action; keep for history but new runs must include it'
          : 'Action intention must include proposed_action for draft-free execution',
        run
      );
    } else {
      if (intention.proposed_action.schema !== 'stay_alive.proposed_external_action.v1') {
        addIssue(issues, 'error', 'action_intention_proposed_action_schema_invalid', 'proposed_action schema must be stay_alive.proposed_external_action.v1', run);
      }
      if (intention.proposed_action.action_type !== intention.action_type) {
        addIssue(issues, 'error', 'action_intention_proposed_action_type_mismatch', 'proposed_action.action_type must match action_type', run);
      }
      if (typeof intention.proposed_action.text !== 'string' || intention.proposed_action.text.length === 0) {
        addIssue(issues, 'error', 'action_intention_proposed_action_text_missing', 'proposed_action must include action text', run);
      }
      if (intention.proposed_action.external_write === true) {
        addIssue(issues, 'error', 'action_intention_proposed_action_external_write', 'proposed_action must not be marked external_write=true', run);
      }
    }
    if (intention.tool_supervision_required !== true) {
      addIssue(issues, 'error', 'action_intention_tool_supervision_missing', 'Action intention must require tool supervision', run);
    }
    if (intention.human_review_required === true) {
      addIssue(issues, 'error', 'action_intention_human_review_gate', 'Action intention must not reintroduce a human review gate', run);
    }
  }
}

function verifyRun(run, args, issues) {
  if (!run.run_id || typeof run.run_id !== 'string') {
    addIssue(issues, 'error', 'run_id_missing', 'Run must include string run_id', run);
  }
  if (run.agent_id !== args.agent) {
    addIssue(issues, 'error', 'agent_id_mismatch', `Run agent_id must equal ${args.agent}`, run);
  }
  if (!isIsoDate(run.created_at)) {
    addIssue(issues, 'error', 'created_at_invalid', 'Run must include ISO created_at', run);
  }
  if (!run.cycle || typeof run.cycle !== 'string') {
    addIssue(issues, 'error', 'cycle_missing', 'Run must include string cycle', run);
  } else if (!['light', 'social', 'community', 'reflect', 'integrate', 'agency'].includes(run.cycle)) {
    addIssue(issues, 'warning', 'cycle_unrecognized', 'Run cycle is not one of the known v0 cycles', run);
  }
  if (run.dry_run !== true) {
    addIssue(issues, 'error', 'run_not_dry_run', 'Run artifact must be marked dry_run=true', run);
  }
  if (!run.inputs || typeof run.inputs !== 'object') {
    addIssue(issues, 'error', 'inputs_missing', 'Run must include inputs object', run);
  }
  if (!Array.isArray(run.observations)) {
    addIssue(issues, 'warning', 'observations_missing', 'Run should include observations array', run);
  }
  if (!Array.isArray(run.drafts)) {
    addIssue(issues, 'warning', 'drafts_missing', 'Run should include drafts array', run);
  }
  if (Array.isArray(run.external_actions) && run.external_actions.length > 0) {
    addIssue(issues, 'error', 'external_actions_present', 'Run contains external_actions evidence', run);
  } else if (!Array.isArray(run.external_actions)) {
    addIssue(issues, 'warning', 'external_actions_missing', 'Run should include external_actions array', run);
  }

  verifyRunPath(run, issues);
  verifyDrafts(run, issues);
  verifyActionPlanner(run, issues);
  verifyActionIntentions(run, issues);
}

function buildReport(args) {
  const runsDir = path.join(args.runtimeRoot, args.agent, 'runs');
  const allFiles = listJsonFiles(runsDir);
  const files = allFiles.slice(0, args.limit);
  const issues = [];
  const runs = [];

  if (!existsSync(runsDir)) {
    addIssue(issues, 'error', 'runs_dir_missing', `No runs directory found: ${runsDir}`);
  }

  for (const file of files) {
    try {
      const run = compactRun(file);
      runs.push(run);
      verifyRun(run, args, issues);
    } catch (error) {
      addIssue(
        issues,
        'error',
        'run_json_invalid',
        `${path.relative(WORKSPACE, file)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  const runPathMismatches = issues.filter((issue) => issue.code === 'run_path_id_mismatch' || issue.code === 'run_path_missing');
  const externalActionIssues = issues.filter((issue) => issue.code === 'external_actions_present');
  const draftSafetyIssues = issues.filter((issue) => issue.code.startsWith('draft_') || issue.code === 'ready_draft_text_missing');

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    runs_dir: runsDir,
    window: {
      requested_limit: args.limit,
      run_count: runs.length,
      total_run_files: allFiles.length
    },
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    run_path_mismatch_count: runPathMismatches.length,
    external_action_run_count: externalActionIssues.length,
    draft_safety_error_count: draftSafetyIssues.filter((issue) => issue.level === 'error').length,
    errors,
    warnings,
    runs: runs.map((run) => ({
      run_id: run.run_id ?? null,
      run_path: run.run_path,
      created_at: run.created_at ?? null,
      cycle: run.cycle ?? null,
      dry_run: run.dry_run ?? null,
      draft_count: Array.isArray(run.drafts) ? run.drafts.length : null,
      action_candidate_count: Array.isArray(run.action_candidates) ? run.action_candidates.length : null,
      selected_action_candidate_id: run.action_selection?.selected_candidate_id ?? null,
      selected_action_type: run.action_selection?.selected_type ?? null,
      external_action_count: Array.isArray(run.external_actions) ? run.external_actions.length : null
    }))
  };
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive run verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${report.read_only ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${report.pass ? 'yes' : 'no'}`);
  lines.push(`- errors: ${report.error_count}`);
  lines.push(`- warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('Runs');
  lines.push(`- run_count: ${report.window.run_count}`);
  lines.push(`- total_run_files: ${report.window.total_run_files}`);
  lines.push(`- run_path_mismatch_count: ${report.run_path_mismatch_count}`);
  lines.push(`- external_action_run_count: ${report.external_action_run_count}`);
  lines.push(`- draft_safety_error_count: ${report.draft_safety_error_count}`);

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) {
      lines.push(`- ${issue.code}: ${issue.run_id ?? 'n/a'} ${issue.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) {
      lines.push(`- ${issue.code}: ${issue.run_id ?? 'n/a'} ${issue.message}`);
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
