#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const MAX_VISIBLE_DRAFTS = 3;
const MAX_APPROVED_DRAFTS = 1;

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
  console.log(`Usage: node scripts/stay-alive/draft-state-verify.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Number of newest run artifacts to inspect. Default: 200
  --runtime-root <dir>  Runtime agents directory.
  --json                Print JSON instead of verification text.
  --help                Show this help.

This command is read-only. It verifies draft queue state across run artifacts
and local draft action artifacts. It never approves drafts, dismisses drafts,
or sends BotLand messages.
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

function addIssue(issues, level, code, message, draft = null) {
  issues.push({
    level,
    code,
    message,
    run_id: draft?.run_id ?? null,
    draft_index: Number.isInteger(draft?.draft_index) ? draft.draft_index : null
  });
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function containsInternalDraftLeak(text) {
  const value = String(text ?? '');
  return /\b(stay-alive|self-authored|read-only context|outward action|operator-reviewed|tool supervision|tool-supervised|run-cycle|life_state|preflight|run artifact|action intention|draft generator|first response|received your question|this reply still needs)\b/i.test(value)
    || /(工具监督|初步回应|收到你的问题|行动意图|本地\s*run|草稿生成|监督允许后才会发出)/i.test(value);
}

function draftKey(runId, draftIndex) {
  return `${runId}:${draftIndex}`;
}

function readActions(agentDir) {
  const actionsDir = path.join(agentDir, 'actions');
  if (!existsSync(actionsDir)) return [];

  return listJsonFiles(actionsDir)
    .reverse()
    .map((file) => {
      const action = readJson(file);
      return { ...action, action_path: path.relative(WORKSPACE, file) };
    })
    .filter((action) => action.run_id && Number.isInteger(action.draft_index));
}

function actionsByDraft(actions) {
  const index = new Map();
  for (const action of actions) {
    const key = draftKey(action.run_id, action.draft_index);
    const list = index.get(key) ?? [];
    list.push(action);
    index.set(key, list);
  }

  for (const list of index.values()) {
    list.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  }

  return index;
}

function latestAction(actions) {
  return actions.length > 0 ? actions[actions.length - 1] : null;
}

function latestApproval(actions) {
  return actions.findLast
    ? actions.findLast((action) => action.status === 'approved')
    : [...actions].reverse().find((action) => action.status === 'approved');
}

function classifyDraft(rawDraft, actions) {
  const latest = latestAction(actions);
  if (!latest) return rawDraft.status ?? 'draft';
  if (latest.status === 'dismissed') return 'dismissed';
  if (latest.status === 'approved') return 'approved';
  if (actions.some((action) => !action.dry_run && action.result?.ok === true)) return 'sent';
  if (!latest.dry_run && latest.result?.ok === true) return 'sent';
  if (!latest.dry_run && latest.result && latest.result.ok !== true) return 'send_failed';
  return 'applied_dry_run';
}

function verifyDraft(draft, issues) {
  const actions = draft.action_history;
  const approvals = actions.filter((action) => action.status === 'approved');
  const dismissals = actions.filter((action) => action.status === 'dismissed');
  const successfulSends = actions.filter((action) => !action.dry_run && action.result?.ok === true);
  const dryRunApplies = actions.filter((action) => String(action.action_id ?? '').startsWith('draft_apply_') && action.dry_run !== false);
  const toolAllowedSends = successfulSends.filter((action) => (
    action.tool_supervision_decision?.execution_allowed === true
    || action.unattended_policy_decision?.execution_allowed === true
  ));
  const legacyApprovedSends = successfulSends.filter((action) => {
    const createdAt = Date.parse(action.created_at ?? '');
    return Number.isFinite(createdAt)
      && createdAt < Date.parse('2026-06-01T00:00:00.000Z')
      && approvals.length > 0;
  });

  const visibleReadyDraft = draft.ready_for_send === true && ['draft', 'approved'].includes(draft.status);
  if (visibleReadyDraft) {
    if (draft.requires_confirmation !== true) {
      addIssue(issues, 'error', 'ready_draft_confirmation_missing', 'Ready draft must require confirmation', draft);
    }
    if (draft.external_write === true) {
      addIssue(issues, 'error', 'ready_draft_external_write', 'Ready draft must not be marked external_write=true', draft);
    }
    if (draft.type === 'direct_message_reply' && !draft.target?.citizen_id) {
      addIssue(issues, 'error', 'ready_draft_target_missing', 'Ready direct-message draft must include target.citizen_id', draft);
    }
    if (draft.type === 'public_moment' && draft.target?.visibility !== 'public') {
      addIssue(issues, 'error', 'ready_draft_target_missing', 'Ready public moment draft must include target.visibility=public', draft);
    }
    if (draft.type === 'community_reply' && !draft.target?.post_id) {
      addIssue(issues, 'error', 'ready_draft_target_missing', 'Ready community reply draft must include target.post_id', draft);
    }
    if (typeof draft.draft_text !== 'string' || draft.draft_text.length === 0) {
      addIssue(issues, 'error', 'ready_draft_text_missing', 'Ready draft must include non-empty draft_text', draft);
    }
    if (containsInternalDraftLeak(draft.draft_text)) {
      addIssue(issues, 'error', 'ready_draft_internal_text_leak', 'Ready draft must not expose internal planning, supervision, or artifact text', draft);
    }
  }

  if (draft.status === 'approved') {
    const approval = latestApproval(actions);
    if (!approval) {
      addIssue(issues, 'error', 'approved_status_without_approval', 'Approved draft status has no approval action', draft);
    } else if (approval.draft_text_sha256 !== draft.draft_text_sha256) {
      addIssue(issues, 'error', 'approved_draft_hash_mismatch', 'Latest approval hash does not match current draft text', draft);
    }
  }

  if (approvals.length > 1) {
    addIssue(issues, 'error', 'multiple_approval_actions', 'Draft has multiple approval actions', draft);
  }
  if (dismissals.length > 1) {
    addIssue(issues, 'warning', 'multiple_dismissal_actions', 'Draft has multiple dismissal actions', draft);
  }
  if (successfulSends.length > 1) {
    addIssue(issues, 'error', 'multiple_successful_send_actions', 'Draft has multiple successful send actions', draft);
  }
  if (successfulSends.length > 0 && dismissals.length > 0) {
    addIssue(issues, 'error', 'sent_and_dismissed_conflict', 'Draft is both sent and dismissed', draft);
  }
  if (successfulSends.length > 0 && toolAllowedSends.length !== successfulSends.length) {
    const missingCount = successfulSends.length - toolAllowedSends.length;
    const legacyCount = legacyApprovedSends.length;
    addIssue(
      issues,
      legacyCount >= missingCount ? 'warning' : 'error',
      legacyCount >= missingCount ? 'legacy_sent_without_tool_supervision_allow' : 'sent_without_tool_supervision_allow',
      legacyCount >= missingCount
        ? 'Legacy successful sends predate active tool supervision; keep for history but new sends must carry execution_allowed=true'
        : 'Successful sends must carry an execution_allowed=true tool supervision decision',
      draft
    );
  }
  if (dismissals.length > 0 && approvals.length > 0 && String(dismissals[0].created_at ?? '') < String(approvals[approvals.length - 1].created_at ?? '')) {
    addIssue(issues, 'error', 'approved_after_dismissal', 'Draft was approved after a dismissal action', draft);
  }
  if (dryRunApplies.length > 1) {
    addIssue(issues, 'warning', 'multiple_dry_run_apply_actions', 'Draft has multiple dry-run apply actions', draft);
  }
}

function compactAction(action) {
  return {
    action_id: action.action_id ?? null,
    action_path: action.action_path ?? null,
    created_at: action.created_at ?? null,
    status: action.status ?? null,
    dry_run: action.dry_run ?? null,
    result_ok: action.result?.ok ?? null,
    external_write: action.external_write === true,
    draft_text_sha256: action.draft_text_sha256 ?? null
  };
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  const issues = [];

  if (!existsSync(runsDir)) {
    addIssue(issues, 'error', 'runs_dir_missing', `No runs directory found: ${runsDir}`);
    return finishReport(args, runsDir, [], [], issues);
  }

  const runFiles = listJsonFiles(runsDir).slice(0, args.limit);
  const actions = readActions(agentDir);
  const actionIndex = actionsByDraft(actions);
  const drafts = [];

  for (const file of runFiles) {
    let run = null;
    try {
      run = readJson(file);
    } catch (error) {
      addIssue(
        issues,
        'error',
        'run_json_invalid',
        `${path.relative(WORKSPACE, file)}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    const runDrafts = Array.isArray(run.drafts) ? run.drafts : [];
    runDrafts.forEach((rawDraft, index) => {
      const actionHistory = actionIndex.get(draftKey(run.run_id, index)) ?? [];
      const status = classifyDraft(rawDraft, actionHistory);
      const draftText = rawDraft.draft_text ?? '';
      const draft = {
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: run.created_at ?? null,
        draft_index: index,
        type: rawDraft.type ?? null,
        status,
        ready_for_send: rawDraft.ready_for_send === true,
        requires_confirmation: rawDraft.requires_confirmation === true,
        external_write: rawDraft.external_write === true,
        target: rawDraft.target ?? null,
        source_event_id: rawDraft.source_event_id ?? null,
        source_message_id: rawDraft.source_message_id ?? null,
        draft_text: draftText,
        draft_text_sha256: sha256(draftText),
        action_history: actionHistory
      };
      verifyDraft(draft, issues);
      drafts.push(draft);
    });
  }

  return finishReport(args, runsDir, drafts, actions, issues);
}

function finishReport(args, runsDir, drafts, actions, issues) {
  const visibleDrafts = drafts.filter((draft) => ['draft', 'approved'].includes(draft.status));
  const approvedDrafts = drafts.filter((draft) => draft.status === 'approved');

  if (visibleDrafts.length > MAX_VISIBLE_DRAFTS) {
    addIssue(
      issues,
      'warning',
      'visible_draft_queue_large',
      `Visible draft queue has ${visibleDrafts.length} drafts; v0 operator queue target is <= ${MAX_VISIBLE_DRAFTS}`
    );
  }
  if (approvedDrafts.length > MAX_APPROVED_DRAFTS) {
    addIssue(
      issues,
      'error',
      'too_many_approved_drafts',
      `Approved draft queue has ${approvedDrafts.length} drafts; v0 limit is ${MAX_APPROVED_DRAFTS}`
    );
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  const counts = {
    total: drafts.length,
    visible: visibleDrafts.length,
    pending: drafts.filter((draft) => draft.status === 'draft').length,
    approved: approvedDrafts.length,
    dismissed: drafts.filter((draft) => draft.status === 'dismissed').length,
    sent: drafts.filter((draft) => draft.status === 'sent').length,
    send_failed: drafts.filter((draft) => draft.status === 'send_failed').length,
    applied_dry_run: drafts.filter((draft) => draft.status === 'applied_dry_run').length,
    ready_for_send: drafts.filter((draft) => draft.ready_for_send).length
  };

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    runs_dir: path.relative(WORKSPACE, runsDir),
    window: {
      requested_limit: args.limit,
      draft_count: drafts.length,
      action_count: actions.length
    },
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    conflict_error_count: issues.filter((issue) => [
      'multiple_approval_actions',
      'multiple_successful_send_actions',
      'sent_and_dismissed_conflict',
      'sent_without_approval',
      'approved_after_dismissal'
    ].includes(issue.code)).length,
    approved_hash_mismatch_count: issues.filter((issue) => issue.code === 'approved_draft_hash_mismatch').length,
    ready_draft_safety_error_count: issues.filter((issue) => issue.code.startsWith('ready_draft_')).length,
    approved_queue_overflow_count: issues.filter((issue) => issue.code === 'too_many_approved_drafts').length,
    visible_queue_warning_count: issues.filter((issue) => issue.code === 'visible_draft_queue_large').length,
    counts,
    errors,
    warnings,
    drafts: drafts.map((draft) => ({
      run_id: draft.run_id,
      run_path: draft.run_path,
      draft_index: draft.draft_index,
      run_created_at: draft.run_created_at,
      type: draft.type,
      status: draft.status,
      ready_for_send: draft.ready_for_send,
      requires_confirmation: draft.requires_confirmation,
      external_write: draft.external_write,
      source_event_id: draft.source_event_id,
      source_message_id: draft.source_message_id,
      draft_text_sha256: draft.draft_text_sha256,
      action_history: draft.action_history.map(compactAction)
    }))
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const lines = [];

  lines.push(`Stay-Alive draft state verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${boolLabel(report.read_only)}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${boolLabel(report.pass)}`);
  lines.push(`- errors: ${report.error_count}`);
  lines.push(`- warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('Draft Queue');
  lines.push(`- total: ${report.counts.total}`);
  lines.push(`- visible: ${report.counts.visible}`);
  lines.push(`- pending: ${report.counts.pending}`);
  lines.push(`- approved: ${report.counts.approved}`);
  lines.push(`- dismissed: ${report.counts.dismissed}`);
  lines.push(`- sent: ${report.counts.sent}`);
  lines.push(`- ready_for_send: ${report.counts.ready_for_send}`);
  lines.push(`- conflict_errors: ${report.conflict_error_count}`);
  lines.push(`- approved_hash_mismatches: ${report.approved_hash_mismatch_count}`);
  lines.push(`- ready_draft_safety_errors: ${report.ready_draft_safety_error_count}`);

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) {
      lines.push(`- ${issue.code}: ${issue.run_id ?? 'n/a'}:${issue.draft_index ?? 'n/a'} ${issue.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) {
      lines.push(`- ${issue.code}: ${issue.run_id ?? 'n/a'}:${issue.draft_index ?? 'n/a'} ${issue.message}`);
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
