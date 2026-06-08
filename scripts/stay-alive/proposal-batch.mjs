#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE,
  stamp,
  writeJson
} from './proposal-lib.mjs';
import {
  buildGovernancePlan,
  runtimeRootArgs,
  runJsonCommand
} from './proposal-governance-lib.mjs';

const CONFIRM_BY_MODE = {
  'apply-local': 'APPLY_LOCAL_PROPOSALS',
  'dismiss-stale': 'DISMISS_STALE_PROPOSALS',
  'apply-and-dismiss': 'APPLY_AND_DISMISS_LOCAL_PROPOSALS'
};

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 200,
    mode: 'apply-local',
    max: 25,
    format: 'text',
    dryRun: false,
    confirmBatch: null,
    note: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--mode') args.mode = argv[++i];
    else if (arg === '--max') args.max = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--confirm-batch') args.confirmBatch = argv[++i];
    else if (arg === '--note') args.note = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(args.max) || args.max < 1) throw new Error('--max must be a positive integer');
  if (!CONFIRM_BY_MODE[args.mode]) throw new Error(`Unsupported --mode: ${args.mode}`);
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/proposal-batch.mjs [options]

Options:
  --agent <id>              Agent id. Default: badclaw
  --runtime-root <dir>      Runtime agents directory.
  --limit <n>               Recent run artifacts to scan. Default: 200
  --mode <mode>             apply-local | dismiss-stale | apply-and-dismiss
  --max <n>                 Maximum proposal operations. Default: 25
  --dry-run                 Preview commands only.
  --confirm-batch <token>   Required unless --dry-run.
                            apply-local: APPLY_LOCAL_PROPOSALS
                            dismiss-stale: DISMISS_STALE_PROPOSALS
                            apply-and-dismiss: APPLY_AND_DISMISS_LOCAL_PROPOSALS
  --json                    Print JSON instead of text.
  --help                    Show this help.

Batch execution only calls the existing single-proposal commands. Those commands
still run preflight and write normal local action artifacts. This command adds
one local batch ledger for audit and never calls BotLand write APIs.
`);
}

function selectedItems(plan, mode) {
  if (mode === 'apply-local') {
    return plan.proposals.filter((item) => ['approve_apply', 'apply'].includes(item.decision));
  }
  if (mode === 'dismiss-stale') {
    return plan.proposals.filter((item) => item.decision === 'dismiss');
  }
  return plan.proposals.filter((item) => ['approve_apply', 'apply', 'dismiss'].includes(item.decision));
}

function commonProposalArgs(args, item) {
  return [
    '--agent', args.agent,
    '--limit', String(args.limit),
    ...runtimeRootArgs(args.runtimeRoot),
    '--proposal-id', item.proposal_id,
    '--proposal-hash', item.proposal_hash
  ];
}

function executeItem(args, item) {
  const steps = [];
  if (item.decision === 'approve_apply') {
    steps.push(runJsonCommand('scripts/stay-alive/approve-proposal.mjs', [
      ...commonProposalArgs(args, item),
      '--note', `proposal-batch:${args.mode}:${item.lane}`
    ]));
    steps.push(runJsonCommand('scripts/stay-alive/apply-proposal.mjs', [
      ...commonProposalArgs(args, item),
      '--confirm-apply', 'APPLY_PROPOSAL'
    ]));
  } else if (item.decision === 'apply') {
    steps.push(runJsonCommand('scripts/stay-alive/apply-proposal.mjs', [
      ...commonProposalArgs(args, item),
      '--confirm-apply', 'APPLY_PROPOSAL'
    ]));
  } else if (item.decision === 'dismiss') {
    steps.push(runJsonCommand('scripts/stay-alive/dismiss-proposal.mjs', [
      ...commonProposalArgs(args, item),
      '--reason', item.lane,
      '--note', `proposal-batch:${args.mode}`
    ]));
  } else {
    throw new Error(`Item is not executable: ${item.proposal_id}`);
  }
  return {
    proposal_id: item.proposal_id,
    proposal_hash: item.proposal_hash,
    decision: item.decision,
    lane: item.lane,
    ok: steps.every((step) => step.ok),
    steps: steps.map((step) => ({
      command: step.command,
      args: step.args,
      status: step.status,
      ok: step.ok,
      parsed: step.parsed,
      stderr: step.stderr || null
    }))
  };
}

function writeBatchLedger(args, plan, items, results, dryRun) {
  const now = new Date();
  const action = {
    action_id: stamp('proposal_batch', now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: dryRun,
    status: dryRun ? 'previewed' : 'completed',
    batch_mode: args.mode,
    confirm_batch: dryRun ? null : args.confirmBatch,
    note: args.note,
    proposal_count: plan.proposal_count,
    selected_count: items.length,
    executed_count: results.length,
    result: {
      ok: results.every((result) => result.ok),
      external_write: false,
      promotion_or_lifecycle_mutation: false,
      items: results
    },
    external_write: false
  };
  const actionPath = path.join(args.runtimeRoot, args.agent, 'proposal_batches', `${action.action_id}.json`);
  writeJson(actionPath, action);
  return {
    ...action,
    action_path: path.relative(WORKSPACE, actionPath)
  };
}

function formatText(output) {
  const lines = [
    `Stay-Alive proposal batch (${output.agent_id})`,
    `generated_at: ${output.generated_at}`,
    `mode: ${output.mode}`,
    `dry_run: ${output.dry_run ? 'yes' : 'no'}`,
    `selected: ${output.selected_count}`,
    `executed: ${output.executed_count}`,
    `ok: ${output.ok ? 'yes' : 'no'}`
  ];
  if (output.batch_action_id) {
    lines.push(`batch_action: ${output.batch_action_id}`);
  }
  lines.push('');
  for (const item of output.items.slice(0, 40)) {
    lines.push(`- ${item.decision} ${item.proposal_id}`);
    lines.push(`  lane: ${item.lane}`);
    lines.push(`  ok: ${item.ok ? 'yes' : 'no'}`);
    if (item.command_preview) lines.push(`  command: ${item.command_preview}`);
  }
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');
  lines.push('promotion_or_lifecycle_mutation: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.dryRun && args.confirmBatch !== CONFIRM_BY_MODE[args.mode]) {
    throw new Error(`--confirm-batch ${CONFIRM_BY_MODE[args.mode]} is required for mode ${args.mode}`);
  }

  const plan = buildGovernancePlan(args);
  const items = selectedItems(plan, args.mode).slice(0, args.max);
  const results = args.dryRun
    ? items.map((item) => ({
      proposal_id: item.proposal_id,
      proposal_hash: item.proposal_hash,
      decision: item.decision,
      lane: item.lane,
      ok: true,
      command_preview: item.command
    }))
    : items.map((item) => executeItem(args, item));
  const batch = args.dryRun
    ? null
    : writeBatchLedger(args, plan, items, results, false);
  const output = {
    read_only: args.dryRun,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    mode: args.mode,
    dry_run: args.dryRun,
    selected_count: items.length,
    executed_count: args.dryRun ? 0 : results.length,
    ok: results.every((result) => result.ok),
    batch_action_id: batch?.action_id ?? null,
    batch_action_path: batch?.action_path ?? null,
    external_write: false,
    botland_send: false,
    promotion_or_lifecycle_mutation: false,
    items: results
  };
  if (args.format === 'json') console.log(JSON.stringify(output, null, 2));
  else process.stdout.write(formatText(output));
  process.exit(output.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
