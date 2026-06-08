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
    includeApplied: false,
    showText: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--include-applied') args.includeApplied = true;
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

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/review-drafts.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Number of recent runs to inspect. Default: 200
  --runtime-root <dir>  Runtime agents directory.
  --include-applied     Include drafts with sent/dry-run action artifacts.
  --show-text           Include full draft text. Default redacts to previews.
  --help                Show this help.
`);
}

function preview(text, limit = 120) {
  if (!text) return '';
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function runtimeRootArg(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? ''
    : ` --runtime-root ${args.runtimeRoot}`;
}

function draftKey(runId, draftIndex) {
  return `${runId}:${draftIndex}`;
}

function readActionIndex(agentDir) {
  const actionsDir = path.join(agentDir, 'actions');
  const index = new Map();
  if (!existsSync(actionsDir)) return index;

  const actionFiles = readdirSync(actionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(actionsDir, name))
    .sort();

  for (const file of actionFiles) {
    const action = JSON.parse(readFileSync(file, 'utf8'));
    if (!action.run_id || !Number.isInteger(action.draft_index)) continue;

    const key = draftKey(action.run_id, action.draft_index);
    const previous = index.get(key);
    const record = {
      action_id: action.action_id,
      action_path: path.relative(WORKSPACE, file),
      created_at: action.created_at,
      status: action.status ?? null,
      dry_run: Boolean(action.dry_run),
      approved: action.status === 'approved',
      dismissed: action.status === 'dismissed',
      sent: Boolean(!action.dry_run && action.result?.ok),
      failed: Boolean(!action.dry_run && action.result && !action.result.ok),
      send_status: action.result?.status ?? null
    };

    if (!previous) {
      index.set(key, record);
      continue;
    }

    if (record.sent || (!previous.sent && record.created_at > previous.created_at)) {
      index.set(key, record);
    }
  }

  return index;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');

  if (!existsSync(runsDir)) {
    throw new Error(`No runs directory found: ${runsDir}`);
  }

  const runFiles = readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, args.limit);

  const actionIndex = readActionIndex(agentDir);
  const drafts = [];
  let appliedDraftCount = 0;
  for (const file of runFiles) {
    const run = JSON.parse(readFileSync(file, 'utf8'));
    const runDrafts = Array.isArray(run.drafts) ? run.drafts : [];
    runDrafts.forEach((draft, index) => {
      const action = actionIndex.get(draftKey(run.run_id, index)) ?? null;
      const computedStatus = action?.dismissed
        ? 'dismissed'
        : action?.approved
        ? 'approved'
        : action?.sent
        ? 'sent'
        : action?.failed
          ? 'send_failed'
          : action
            ? 'applied_dry_run'
            : draft.status ?? 'draft';
      if (action) appliedDraftCount += 1;
      if (!args.includeApplied && action && computedStatus !== 'approved') return;

      drafts.push({
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        draft_index: index,
        created_at: run.created_at,
        type: draft.type,
        status: computedStatus,
        ready_for_send: draft.ready_for_send === true,
        requires_confirmation: draft.requires_confirmation,
        external_write: draft.external_write,
        target: draft.target,
        source_event_id: draft.source_event_id,
        source_message_id: draft.source_message_id,
        latest_action: action,
        source_text_preview: preview(draft.source_text_preview),
        draft_text: args.showText ? draft.draft_text : preview(draft.draft_text),
        apply_dry_run_command: `node scripts/stay-alive/apply-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index}`,
        apply_send_command: `node scripts/stay-alive/apply-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index} --confirm-send SEND_DRAFT`,
        approve_command: `node scripts/stay-alive/approve-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index}`,
        dismiss_command: `node scripts/stay-alive/dismiss-draft.mjs --agent ${args.agent}${runtimeRootArg(args)} --run ${run.run_id} --draft-index ${index}`
      });
    });
  }

  console.log(JSON.stringify({
    agent_id: args.agent,
    runs_inspected: runFiles.length,
    draft_count: drafts.length,
    applied_draft_count: appliedDraftCount,
    include_applied: args.includeApplied,
    drafts
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
