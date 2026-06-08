#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    actionId: null,
    inspectedBy: 'operator',
    note: 'successful send inspected',
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--action-id') args.actionId = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--inspected-by') args.inspectedBy = argv[++i];
    else if (arg === '--note') args.note = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/inspect-send.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --action-id <id>         Successful send action id to inspect. Default: latest uninspected send.
  --runtime-root <dir>     Runtime agents directory.
  --inspected-by <name>    Local inspector label. Default: operator
  --note <text>            Inspection note.
  --json                   Print JSON instead of text.
  --help                   Show this help.

This command writes a local-only inspection artifact for a successful send.
It never sends BotLand messages and never modifies run artifacts.
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
    .sort();
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function actionId(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `send_inspect_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function readActions(actionsDir) {
  return listJsonFiles(actionsDir).map((file) => ({
    ...readJson(file),
    action_path: path.relative(WORKSPACE, file)
  }));
}

function isSuccessfulSend(action) {
  return action.dry_run === false && action.result?.ok === true;
}

function isInspection(action) {
  return action.status === 'successful_send_inspected'
    || String(action.action_id ?? '').startsWith('send_inspect_');
}

function findTargetSend(actions, requestedActionId) {
  const inspectedIds = new Set(actions
    .filter(isInspection)
    .map((action) => action.inspected_action_id)
    .filter(Boolean));
  const successfulSends = actions
    .filter(isSuccessfulSend)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  if (requestedActionId) {
    const action = successfulSends.find((candidate) => candidate.action_id === requestedActionId);
    if (!action) throw new Error(`Successful send action not found: ${requestedActionId}`);
    if (inspectedIds.has(action.action_id)) {
      throw new Error(`Successful send action already inspected: ${requestedActionId}`);
    }
    return action;
  }

  const target = successfulSends.find((action) => !inspectedIds.has(action.action_id));
  if (!target) throw new Error('No uninspected successful send action found');
  return target;
}

function resolveRunPath(args, sendAction) {
  if (sendAction.run_path) {
    return path.resolve(WORKSPACE, sendAction.run_path);
  }
  return path.join(args.runtimeRoot, args.agent, 'runs', `${sendAction.run_id}.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const actionsDir = path.join(agentDir, 'actions');
  const actions = readActions(actionsDir);
  const sendAction = findTargetSend(actions, args.actionId);
  const runPath = resolveRunPath(args, sendAction);
  if (!existsSync(runPath)) throw new Error(`Referenced run artifact not found: ${runPath}`);

  const run = readJson(runPath);
  const draft = Array.isArray(run.drafts) ? run.drafts[sendAction.draft_index] : null;
  if (!draft) throw new Error(`Referenced draft ${sendAction.run_id}:${sendAction.draft_index} was not found`);

  const currentDraftHash = sha256(draft.draft_text ?? '');
  if (sendAction.draft_text_sha256 && sendAction.draft_text_sha256 !== currentDraftHash) {
    throw new Error(`Send action hash mismatch: action=${sendAction.draft_text_sha256}, current=${currentDraftHash}`);
  }

  const now = new Date();
  const inspection = {
    action_id: actionId(now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: 'successful_send_inspected',
    dry_run: true,
    external_write: false,
    run_id: sendAction.run_id,
    run_path: path.relative(WORKSPACE, runPath),
    draft_index: sendAction.draft_index,
    source_event_id: sendAction.source_event_id ?? draft.source_event_id ?? null,
    source_message_id: sendAction.source_message_id ?? draft.source_message_id ?? null,
    target: sendAction.target ?? draft.target ?? null,
    draft_text_sha256: currentDraftHash,
    inspected_action_id: sendAction.action_id,
    inspected_action_path: sendAction.action_path,
    inspected_at: now.toISOString(),
    inspected_by: args.inspectedBy,
    inspection_note: args.note,
    inspected_send_result: {
      ok: sendAction.result?.ok ?? null,
      status: sendAction.result?.status ?? null,
      stdout_json: sendAction.result?.stdout_json ?? null
    },
    result: {
      ok: true,
      status: 'inspected',
      external_write: false
    }
  };

  mkdirSync(actionsDir, { recursive: true });
  const inspectionPath = path.join(actionsDir, `${inspection.action_id}.json`);
  writeFileSync(inspectionPath, `${JSON.stringify(inspection, null, 2)}\n`);

  const output = {
    action_id: inspection.action_id,
    action_path: path.relative(WORKSPACE, inspectionPath),
    inspected_action_id: sendAction.action_id,
    run_id: inspection.run_id,
    draft_index: inspection.draft_index,
    local_only: true,
    external_write: false,
    result: inspection.result
  };

  if (args.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`successful_send_inspected: ${output.action_id}`);
    console.log(`inspected_action_id: ${output.inspected_action_id}`);
    console.log(`action_path: ${output.action_path}`);
    console.log('external_write: no');
    console.log('botland_send: no');
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
