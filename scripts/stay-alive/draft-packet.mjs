#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    draftIndex: 0,
    limit: 200,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    showText: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--run') args.run = argv[++i];
    else if (arg === '--draft-index') args.draftIndex = Number.parseInt(argv[++i], 10);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--redact-text') args.showText = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.draftIndex) || args.draftIndex < 0) {
    throw new Error('--draft-index must be a non-negative integer');
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/draft-packet.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --run <run_id|path>   Specific run artifact. Default: latest visible draft.
  --draft-index <n>     Draft index in run.drafts. Default: 0
  --limit <n>           Recent run search window when --run is omitted. Default: 200
  --runtime-root <dir>  Runtime agents directory.
  --redact-text         Print previews instead of full source/draft text.
  --help                Show this help.

This command is read-only. It never writes action artifacts and never sends BotLand messages.
`);
}

function preview(text, limit = 180) {
  if (!text) return '';
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function draftKey(runId, draftIndex) {
  return `${runId}:${draftIndex}`;
}

function runtimeRootArg(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? ''
    : ` --runtime-root ${args.runtimeRoot}`;
}

function resolveRunPath(args) {
  if (!args.run) return null;
  if (args.run.includes('/') || args.run.endsWith('.json')) {
    return path.resolve(args.run);
  }
  return path.join(args.runtimeRoot, args.agent, 'runs', `${args.run}.json`);
}

function readActions(agentDir, runId, draftIndex) {
  const actionsDir = path.join(agentDir, 'actions');
  if (!existsSync(actionsDir)) return [];

  return readdirSync(actionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(actionsDir, name))
    .map((file) => {
      const action = JSON.parse(readFileSync(file, 'utf8'));
      return { ...action, action_path: path.relative(WORKSPACE, file) };
    })
    .filter((action) => draftKey(action.run_id, action.draft_index) === draftKey(runId, draftIndex))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

function latestAction(actions) {
  if (actions.length === 0) return null;
  return actions[actions.length - 1];
}

function latestApproval(actions) {
  return actions.findLast
    ? actions.findLast((action) => action.status === 'approved')
    : [...actions].reverse().find((action) => action.status === 'approved');
}

function draftStatus(draft, actions) {
  const latest = latestAction(actions);
  if (!latest) return draft.status ?? 'draft';
  if (latest.status === 'dismissed') return 'dismissed';
  if (latest.status === 'approved') return 'approved';
  if (!latest.dry_run && latest.result?.ok) return 'sent';
  if (!latest.dry_run && latest.result && !latest.result.ok) return 'send_failed';
  return 'applied_dry_run';
}

function loadRunFiles(args) {
  const specificRunPath = resolveRunPath(args);
  if (specificRunPath) {
    if (!existsSync(specificRunPath)) throw new Error(`Run artifact not found: ${specificRunPath}`);
    return [specificRunPath];
  }

  const runsDir = path.join(args.runtimeRoot, args.agent, 'runs');
  if (!existsSync(runsDir)) throw new Error(`No runs directory found: ${runsDir}`);
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, args.limit);
}

function selectDraft(args, agentDir) {
  const runFiles = loadRunFiles(args);

  for (const file of runFiles) {
    const run = JSON.parse(readFileSync(file, 'utf8'));
    const drafts = Array.isArray(run.drafts) ? run.drafts : [];
    const indexes = args.run ? [args.draftIndex] : drafts.map((_, index) => index);

    for (const index of indexes) {
      const draft = drafts[index];
      if (!draft) continue;
      const actions = readActions(agentDir, run.run_id, index);
      const status = draftStatus(draft, actions);
      if (!args.run && !['draft', 'approved'].includes(status)) continue;
      return { run, runPath: file, draft, draftIndex: index, actions, status };
    }
  }

  throw new Error(args.run ? `Draft index ${args.draftIndex} not found` : 'No visible draft found');
}

function policyChecks(draft, actions, status, currentHash) {
  const approval = latestApproval(actions);
  const supportedType = ['direct_message_reply', 'public_moment', 'community_reply'].includes(draft.type);
  const hasTarget = draft.type === 'direct_message_reply'
    ? Boolean(draft.target?.citizen_id)
    : draft.type === 'public_moment'
      ? draft.target?.visibility === 'public'
      : draft.type === 'community_reply'
        ? Boolean(draft.target?.post_id)
      : false;
  return {
    supported_type: supportedType,
    ready_for_send: draft.ready_for_send === true,
    requires_confirmation: draft.requires_confirmation === true,
    no_external_write_marker: draft.external_write === false,
    has_target_citizen_id: hasTarget,
    has_draft_text: Boolean(draft.draft_text),
    not_already_sent: !actions.some((action) => !action.dry_run && action.result?.ok),
    not_dismissed: status !== 'dismissed',
    approved: Boolean(approval),
    approval_hash_matches: approval ? approval.draft_text_sha256 === currentHash : null
  };
}

function commandSet(args, runId, draftIndex) {
  const base = `--agent ${args.agent}${runtimeRootArg(args)} --run ${runId} --draft-index ${draftIndex}`;
  return {
    refresh_packet: `node scripts/stay-alive/draft-packet.mjs ${base}`,
    review_queue: `node scripts/stay-alive/review-drafts.mjs --agent ${args.agent}${runtimeRootArg(args)} --limit ${args.limit} --show-text`,
    approve_only: `node scripts/stay-alive/approve-draft.mjs ${base}`,
    dismiss_only: `node scripts/stay-alive/dismiss-draft.mjs ${base}`,
    dry_run_apply: `node scripts/stay-alive/apply-draft.mjs ${base}`,
    send_after_approval_and_second_confirmation: `node scripts/stay-alive/apply-draft.mjs ${base} --confirm-send SEND_DRAFT`
  };
}

function compactAction(action) {
  return {
    action_id: action.action_id,
    action_path: action.action_path,
    created_at: action.created_at,
    status: action.status ?? null,
    dry_run: Boolean(action.dry_run),
    result_ok: action.result?.ok ?? null,
    draft_text_sha256: action.draft_text_sha256 ?? null,
    approved_by: action.approved_by ?? null
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const selected = selectDraft(args, agentDir);
  const currentHash = sha256(selected.draft.draft_text ?? '');
  const approval = latestApproval(selected.actions);
  const latest = latestAction(selected.actions);

  console.log(JSON.stringify({
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    run_id: selected.run.run_id,
    run_path: path.relative(WORKSPACE, selected.runPath),
    run_created_at: selected.run.created_at,
    draft_index: selected.draftIndex,
    status: selected.status,
    draft: {
      type: selected.draft.type,
      target: selected.draft.target ?? null,
      source_event_id: selected.draft.source_event_id ?? null,
      source_message_id: selected.draft.source_message_id ?? null,
      source_text: args.showText
        ? selected.draft.source_text_preview ?? ''
        : preview(selected.draft.source_text_preview),
      draft_text: args.showText ? selected.draft.draft_text : preview(selected.draft.draft_text),
      draft_text_sha256: currentHash,
      ready_for_send: selected.draft.ready_for_send === true,
      requires_confirmation: selected.draft.requires_confirmation === true,
      external_write: selected.draft.external_write === true
    },
    latest_action: latest ? compactAction(latest) : null,
    latest_approval: approval ? compactAction(approval) : null,
    policy_checks: policyChecks(selected.draft, selected.actions, selected.status, currentHash),
    commands: commandSet(args, selected.run.run_id, selected.draftIndex),
    action_history: selected.actions.map(compactAction)
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
