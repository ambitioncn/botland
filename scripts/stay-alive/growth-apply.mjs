#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildGrowthApplyContext } from './growth-apply-lib.mjs';
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
    writeProposalLedgers: false,
    confirmWrite: null,
    output: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--write-proposal-ledgers') args.writeProposalLedgers = true;
    else if (arg === '--confirm-write') args.confirmWrite = argv[++i];
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.writeProposalLedgers && args.confirmWrite !== 'WRITE_GROWTH_APPLY_LEDGERS') {
    throw new Error('Writing proposal ledgers requires --confirm-write WRITE_GROWTH_APPLY_LEDGERS');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/growth-apply.mjs [options]

Options:
  --agent <id>               Agent id. Default: badclaw
  --runtime-root <dir>       Runtime agents directory.
  --limit <n>                Recent artifacts to inspect. Default: 50
  --dry-run                  Build context without writing a growth_apply ledger.
  --write-proposal-ledgers   Also write proposal ledgers for memory/desire patch candidates.
  --confirm-write <token>    Required token: WRITE_GROWTH_APPLY_LEDGERS
  --output <file>            Optional JSON report path.
  --json                     Print JSON instead of text.
  --help                     Show this help.

Growth Apply turns growth-continuity evidence into local proposal ledgers,
self-question threads, journal reflections, identity governance decisions,
desire lifecycle proposals, and real-interaction smoke plans. It never sends
BotLand messages and never mutates life_state directly.
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

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function proposalFileName(prefix, proposal) {
  return `${prefix}_${hash(proposal).slice(0, 24)}.json`;
}

function writeProposalLedgers(agentDir, context, nowIso) {
  const written = [];
  const promotion = context.growth_promotion_apply_v1;
  for (const proposal of promotion.memory_proposals ?? []) {
    const file = path.join(agentDir, 'memory_updates', proposalFileName('growth_memory', proposal));
    writeJson(file, {
      schema: 'stay_alive.growth_apply_proposal_ledger.v1',
      created_at: nowIso,
      agent_id: context.agent_id,
      status: 'proposed',
      proposal_hash: hash(proposal),
      payload: proposal.payload,
      source: 'growth_promotion_apply_v1',
      local_only: true,
      external_write: false,
      direct_memory_write: false
    });
    written.push(path.relative(WORKSPACE, file));
  }
  for (const proposal of promotion.self_model_patch_proposals ?? []) {
    const file = path.join(agentDir, 'memory_updates', proposalFileName('identity_patch', proposal));
    writeJson(file, {
      schema: 'stay_alive.growth_apply_proposal_ledger.v1',
      created_at: nowIso,
      agent_id: context.agent_id,
      status: 'proposed',
      proposal_hash: hash(proposal),
      payload: proposal.payload,
      source: 'identity_patch_governance_v1',
      local_only: true,
      external_write: false,
      direct_life_state_mutation: false
    });
    written.push(path.relative(WORKSPACE, file));
  }
  for (const proposal of promotion.desire_lifecycle_proposals ?? []) {
    if (!proposal.payload?.desire_id) continue;
    const file = path.join(agentDir, 'desire_updates', proposalFileName('growth_desire_lifecycle', proposal));
    writeJson(file, {
      schema: 'stay_alive.growth_apply_desire_ledger.v1',
      created_at: nowIso,
      agent_id: context.agent_id,
      status: 'proposed',
      proposal_hash: hash(proposal),
      payload: proposal.payload,
      source: 'desire_lifecycle_apply_v1',
      local_only: true,
      external_write: false,
      direct_life_state_mutation: false
    });
    written.push(path.relative(WORKSPACE, file));
  }
  return written;
}

function buildResult(args) {
  const now = new Date();
  const nowIso = now.toISOString();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(lifeStatePath)) throw new Error(`Missing life_state.json: ${lifeStatePath}`);
  const lifeState = readJson(lifeStatePath);
  const runs = listJson(path.join(agentDir, 'runs'), args.limit);
  const outcomes = listJson(path.join(agentDir, 'action_outcomes'), args.limit);
  const growthContinuityLedgers = listJson(path.join(agentDir, 'growth_continuity'), args.limit);
  const agencyJournals = listJson(path.join(agentDir, 'agency_journal'), args.limit);
  const selfDiscoveryGrowthContext = buildSelfDiscoveryGrowthContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    generatedAt: nowIso
  });
  const growthContinuityContext = buildGrowthContinuityContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    selfDiscoveryGrowthContext,
    generatedAt: nowIso
  });
  const context = buildGrowthApplyContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    growthContinuityContext,
    growthContinuityLedgers,
    agencyJournals,
    generatedAt: nowIso
  });
  const ledgerId = `growth_apply_${stamp(now)}_${args.agent}`;
  const ledgerPath = path.join(agentDir, 'growth_apply', `${ledgerId}.json`);
  const result = {
    schema: 'stay_alive.growth_apply_result.v1',
    generated_at: nowIso,
    agent_id: args.agent,
    dry_run: args.dryRun,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutated: false,
    direct_memory_write: false,
    ledger_path: path.relative(WORKSPACE, ledgerPath),
    proposal_ledgers_written: [],
    context
  };
  if (!args.dryRun) {
    writeJson(ledgerPath, context);
  }
  if (args.writeProposalLedgers) {
    result.proposal_ledgers_written = writeProposalLedgers(agentDir, context, nowIso);
  }
  return result;
}

function formatText(result) {
  const context = result.context;
  const promotion = context.growth_promotion_apply_v1;
  return [
    `Growth Apply (${result.agent_id})`,
    `generated_at: ${result.generated_at}`,
    `dry_run: ${result.dry_run}`,
    `external_write: ${result.external_write}`,
    `apply_readiness: ${context.apply_readiness.verdict} (${context.apply_readiness.score})`,
    `memory_proposals: ${promotion.proposal_counts.memory}`,
    `self_model_patch_proposals: ${promotion.proposal_counts.self_model_patch}`,
    `desire_lifecycle_proposals: ${promotion.proposal_counts.desire_lifecycle}`,
    `self_question_threads: ${context.self_question_continuity_engine_v1.thread_count}`,
    `journal_reviews: ${context.growth_journal_reflection_cycle_v1.review_count}`,
    `identity_governance_decisions: ${context.identity_patch_governance_v1.decision_count}`,
    `smoke_plans: ${context.real_interaction_calibration_smoke_v1.smoke_plan_count}`,
    `proposal_ledgers_written: ${result.proposal_ledgers_written.length}`,
    `ledger_path: ${result.ledger_path}`
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = buildResult(args);
  if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatText(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
