#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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
  console.log(`Usage: node scripts/stay-alive/self-discovery-growth.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --limit <n>              Recent runs/outcomes to inspect. Default: 50
  --dry-run                Build context without writing a ledger.
  --output <file>          Optional JSON report path.
  --json                   Print JSON instead of text.
  --help                   Show this help.

Self-Discovery Growth turns recent experience into local-only self-question,
self-model, relationship-growth, and private experiment context. It never
sends BotLand messages and never mutates life_state.
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
  const context = buildSelfDiscoveryGrowthContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    generatedAt: now.toISOString()
  });
  const ledgerId = `self_discovery_growth_${stamp(now)}_${args.agent}`;
  const ledgerPath = path.join(agentDir, 'self_discovery_growth', `${ledgerId}.json`);
  return {
    schema: 'stay_alive.self_discovery_growth_result.v1',
    generated_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutated: false,
    ledger_path: path.relative(WORKSPACE, ledgerPath),
    context
  };
}

function formatText(result) {
  return [
    `Self-Discovery Growth (${result.agent_id})`,
    `generated_at: ${result.generated_at}`,
    `dry_run: ${result.dry_run}`,
    `external_write: ${result.external_write}`,
    `growth_readiness: ${result.context.growth_readiness.verdict} (${result.context.growth_readiness.score})`,
    `self_questions: ${result.context.self_question_evolution_v1.questions.length}`,
    `self_model_candidates: ${result.context.experience_to_self_model_integration_v1.candidate_count}`,
    `relationship_hypotheses: ${result.context.relationship_driven_growth_v1.hypotheses.length}`,
    `growth_experiments: ${result.context.autonomous_growth_experiment_v1.experiments.length}`,
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
