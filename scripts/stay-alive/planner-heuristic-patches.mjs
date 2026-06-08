#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { WORKSPACE } from './proposal-lib.mjs';
import {
  buildPatchLedgerFromTraceReviews,
  loadActivePlannerPatchContext,
  readRecentOutcomes,
  relativeWorkspacePath,
  validatePlannerPatches,
  writePatchLedger
} from './planner-patch-lib.mjs';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 20,
    dryRun: false,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/planner-heuristic-patches.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent trace review ledgers to scan. Default: 20
  --dry-run             Build patch ledger without writing planner_patches.
  --json                Print JSON instead of text.
  --help                Show this help.

This command is local-only. It converts trace-review heuristic proposals into a
bounded planner patch ledger, validates patches against recent outcomes, and
never sends BotLand messages, mutates life_state, or patches code.
`);
}

function buildReport(args) {
  const now = new Date().toISOString();
  const ledger = buildPatchLedgerFromTraceReviews({
    runtimeRoot: args.runtimeRoot,
    agent: args.agent,
    now,
    limit: args.limit
  });
  const writtenPath = args.dryRun ? null : writePatchLedger(args.runtimeRoot, args.agent, ledger);
  const patchContext = loadActivePlannerPatchContext(args.runtimeRoot, args.agent, now, args.limit);
  const validation = validatePlannerPatches(
    args.runtimeRoot,
    args.agent,
    {
      ...patchContext,
      patches: args.dryRun ? ledger.patches.filter((patch) => patch.status === 'active') : patchContext.patches,
      active_patch_count: args.dryRun ? ledger.patches.filter((patch) => patch.status === 'active').length : patchContext.active_patch_count
    },
    readRecentOutcomes(args.runtimeRoot, args.agent, 50),
    now
  );
  return {
    schema: 'stay_alive.planner_heuristic_patch_application_report.v1',
    generated_at: now,
    agent_id: args.agent,
    dry_run: args.dryRun,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutation: false,
    direct_code_mutation: false,
    ledger,
    ledger_path: writtenPath ? relativeWorkspacePath(writtenPath) : null,
    active_patch_context: args.dryRun
      ? {
          ...patchContext,
          active_patch_count: ledger.patches.filter((patch) => patch.status === 'active').length,
          patches: ledger.patches.filter((patch) => patch.status === 'active')
        }
      : patchContext,
    patch_outcome_validation: validation,
    safety: {
      patch_application_is_planner_scoring_only: true,
      tool_supervision_authoritative: true,
      external_action_policy_mutation: false,
      high_risk_permission_expansion: false,
      durable_state_mutation: false
    }
  };
}

function formatText(report) {
  return [
    `Stay-Alive planner heuristic patches (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `dry_run: ${report.dry_run ? 'yes' : 'no'}`,
    `patches_built: ${report.ledger.patch_count}`,
    `active_patches: ${report.active_patch_context.active_patch_count}`,
    `validations: ${report.patch_outcome_validation.validation_count}`,
    report.ledger_path ? `ledger_path: ${report.ledger_path}` : 'ledger_path: dry-run',
    '',
    'Safety',
    '- external_write: no',
    '- botland_send: no',
    '- life_state_mutation: no',
    '- direct_code_mutation: no'
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
