#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { WORKSPACE } from './proposal-lib.mjs';
import { buildGovernancePlan } from './proposal-governance-lib.mjs';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 200,
    format: 'text',
    includeClosed: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--include-closed') args.includeClosed = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/proposal-governor.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent run artifacts to scan. Default: 200
  --include-closed      Include applied/dismissed/closed proposals.
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It classifies visible Stay-Alive proposals into
safe local apply, stale dismissal, or manual review lanes. It never approves,
applies, dismisses, promotes, sends, posts, joins, or reports.
`);
}

function formatText(plan) {
  const lines = [
    `Stay-Alive proposal governor (${plan.agent_id})`,
    `generated_at: ${plan.generated_at}`,
    `proposals: ${plan.proposal_count}`,
    `groups: ${plan.group_count}`,
    `duplicate_groups: ${plan.duplicate_group_count}`,
    `visible: ${plan.visible_count}`,
    `executable: ${plan.executable_count}`,
    `manual_review: ${plan.review_count}`,
    '',
    'Decision Counts'
  ];
  for (const [decision, count] of Object.entries(plan.counts_by_decision).sort()) {
    lines.push(`- ${decision}: ${count}`);
  }
  lines.push('');
  lines.push('Lane Counts');
  for (const [lane, count] of Object.entries(plan.counts_by_lane).sort()) {
    lines.push(`- ${lane}: ${count}`);
  }
  lines.push('');
  lines.push('Visible Plan');
  for (const item of plan.proposals.slice(0, 40)) {
    lines.push(`- ${item.decision} ${item.proposal_id}`);
    lines.push(`  kind: ${item.kind} cycle=${item.cycle} lane=${item.lane} risk=${item.risk}`);
    lines.push(`  target: ${item.target_path ?? item.type ?? 'n/a'} duplicates=${item.duplicate_count}`);
    lines.push(`  reason: ${item.reason}`);
    if (item.text_preview) lines.push(`  text: ${item.text_preview}`);
  }
  lines.push('');
  lines.push('Next Commands');
  lines.push(`- dry_run_apply: ${plan.next_commands.dry_run_batch_apply}`);
  lines.push(`- confirm_apply: ${plan.next_commands.confirmed_batch_apply}`);
  lines.push(`- dry_run_dismiss_stale: ${plan.next_commands.dry_run_dismiss_stale}`);
  lines.push(`- confirm_dismiss_stale: ${plan.next_commands.confirmed_dismiss_stale}`);
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
  const plan = buildGovernancePlan(args);
  if (args.format === 'json') console.log(JSON.stringify(plan, null, 2));
  else process.stdout.write(formatText(plan));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
