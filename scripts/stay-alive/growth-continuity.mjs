#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildGrowthContinuityContext } from './growth-continuity-lib.mjs';
import { buildSelfDiscoveryGrowthContext } from './self-discovery-growth-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    limit: 50,
    dryRun: false,
    output: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
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
  console.log(`Usage: node scripts/stay-alive/growth-continuity.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --limit <n>              Recent runs/outcomes to inspect. Default: 50
  --dry-run                Build context without writing a ledger.
  --output <file>          Optional JSON report path.
  --json                   Print JSON instead of text.
  --help                   Show this help.

Growth Continuity turns self-discovery growth material into local-only
promotion/lifecycle/experiment/identity/desire/calibration evidence. It never
sends BotLand messages, never writes long-term memory directly, and never
mutates life_state.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJsonOrNull(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function listJson(dir, limit) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(readJsonOrNull)
    .filter(Boolean);
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildResult(args) {
  const now = new Date();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(lifeStatePath)) throw new Error(`Missing life_state.json: ${lifeStatePath}`);
  const lifeState = readJson(lifeStatePath);
  const runs = listJson(path.join(agentDir, 'runs'), args.limit);
  const outcomes = listJson(path.join(agentDir, 'action_outcomes'), args.limit);
  const selfDiscoveryGrowthContext = buildSelfDiscoveryGrowthContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    generatedAt: now.toISOString()
  });
  const context = buildGrowthContinuityContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    selfDiscoveryGrowthContext,
    generatedAt: now.toISOString()
  });
  const ledgerId = `growth_continuity_${stamp(now)}_${args.agent}`;
  const ledgerPath = path.join(agentDir, 'growth_continuity', `${ledgerId}.json`);
  return {
    schema: 'stay_alive.growth_continuity_result.v1',
    generated_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutated: false,
    direct_memory_write: false,
    ledger_path: path.relative(WORKSPACE, ledgerPath),
    context
  };
}

function formatText(result) {
  const context = result.context;
  return [
    `Growth Continuity (${result.agent_id})`,
    `generated_at: ${result.generated_at}`,
    `dry_run: ${result.dry_run}`,
    `external_write: ${result.external_write}`,
    `continuity_readiness: ${context.continuity_readiness.verdict} (${context.continuity_readiness.score})`,
    `growth_memory_candidates: ${context.growth_memory_promotion_v1.candidate_count}`,
    `ready_memory_candidates: ${context.growth_memory_promotion_v1.ready_for_review_count}`,
    `self_question_lifecycle_records: ${context.self_question_lifecycle_v1.question_count}`,
    `growth_experiment_executions: ${context.growth_experiment_execution_loop_v1.experiment_count}`,
    `identity_update_candidates: ${context.interaction_outcome_to_identity_update_v1.candidate_count}`,
    `desire_evolution_records: ${context.desire_evolution_from_self_discovery_v1.record_count}`,
    `interaction_calibration: ${context.real_interaction_calibration_v1.readiness}`,
    `ledger_path: ${result.ledger_path}`
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = buildResult(args);
  if (!args.dryRun) {
    const outputPath = path.join(WORKSPACE, result.ledger_path);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result.context, null, 2)}\n`);
  }
  if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatText(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
