#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE
} from './proposal-lib.mjs';
import {
  actionOutcomesDir,
  buildActionOutcome,
  inspectedSuccessfulSends,
  readOutcomeIndex,
  writeOutcome
} from './action-outcome-lib.mjs';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 50,
    format: 'text',
    actionId: null,
    dryRun: false,
    includeExisting: false,
    noBotland: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--action-id') args.actionId = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--include-existing') args.includeExisting = true;
    else if (arg === '--no-botland') args.noBotland = true;
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
  console.log(`Usage: node scripts/stay-alive/action-outcome.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Inspected successful sends to scan. Default: 50
  --action-id <id>      Scan one inspected successful send action.
  --dry-run             Build outcome without writing action_outcomes ledger.
  --include-existing    Re-scan actions that already have an outcome ledger.
  --no-botland          Do not run BotLand read probes; useful for fixtures.
  --json                Print JSON instead of text.
  --help                Show this help.

This command performs only BotLand read probes and local ledger writes. It never
sends, posts, replies, joins, reports, promotes, or mutates life_state.
`);
}

function formatText(report) {
  const lines = [
    `Stay-Alive action outcome (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `dry_run: ${report.dry_run ? 'yes' : 'no'}`,
    `inspected_successful_send_count: ${report.inspected_successful_send_count}`,
    `selected_count: ${report.selected_count}`,
    `written_count: ${report.written_count}`,
    `skipped_existing_count: ${report.skipped_existing_count}`,
    '',
    'Outcomes'
  ];
  for (const item of report.outcomes) {
    lines.push(`- ${item.send_action_id}: ${item.action_type} ${item.outcome_status}`);
    lines.push(`  feedback_count: ${item.observation.feedback_count}`);
    if (item.action_quality_score) lines.push(`  action_quality: ${item.action_quality_score.rating} (${item.action_quality_score.overall})`);
    if (item.growth_integration) lines.push(`  growth_integration: ${item.growth_integration.integration_status}`);
    lines.push(`  proposals: memory=${item.proposal_counts.memory_updates} relationship=${item.proposal_counts.relationship_updates} commitment=${item.proposal_counts.commitment_updates} desire=${item.proposal_counts.desire_updates}`);
    if (item.outcome_path) lines.push(`  path: ${item.outcome_path}`);
  }
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');
  lines.push('life_state_mutation: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const pairs = inspectedSuccessfulSends(args.runtimeRoot, args.agent);
  const existing = readOutcomeIndex(args.runtimeRoot, args.agent);
  const selected = pairs
    .filter((pair) => !args.actionId || pair.send_action.action_id === args.actionId)
    .filter((pair) => args.includeExisting || !existing.has(pair.send_action.action_id))
    .slice(0, args.limit);
  if (args.actionId && selected.length === 0) {
    throw new Error(`No inspected successful send selected for action-id ${args.actionId}`);
  }

  const outcomes = selected.map((pair) => {
    const outcome = buildActionOutcome(args, pair);
    const counts = {
      memory_updates: outcome.memory_updates.length,
      relationship_updates: outcome.relationship_updates.length,
      commitment_updates: outcome.commitment_updates.length,
      desire_updates: outcome.desire_updates.length
    };
    const file = args.dryRun ? null : writeOutcome(args.runtimeRoot, args.agent, outcome);
    return {
      send_action_id: outcome.send_action_id,
      action_type: outcome.action_type,
      outcome_status: outcome.outcome_status,
      observation: outcome.observation,
      proposal_counts: counts,
      outcome_id: outcome.outcome_id,
      outcome_path: file ? path.relative(WORKSPACE, file) : null,
      read_checks: outcome.read_checks,
      action_quality_score: outcome.action_quality_score,
      growth_integration: outcome.growth_integration,
      relationship_updates: outcome.relationship_updates,
      commitment_updates: outcome.commitment_updates,
      desire_updates: outcome.desire_updates
    };
  });

  const report = {
    read_only_botland: true,
    local_ledger_write: !args.dryRun,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    outcome_dir: path.relative(WORKSPACE, actionOutcomesDir(args.runtimeRoot, args.agent)),
    dry_run: args.dryRun,
    include_existing: args.includeExisting,
    inspected_successful_send_count: pairs.length,
    existing_outcome_count: existing.size,
    skipped_existing_count: pairs.filter((pair) => existing.has(pair.send_action.action_id)).length,
    selected_count: selected.length,
    written_count: args.dryRun ? 0 : outcomes.length,
    outcomes,
    safety: {
      external_write: false,
      botland_send: false,
      life_state_mutation: false
    }
  };

  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
