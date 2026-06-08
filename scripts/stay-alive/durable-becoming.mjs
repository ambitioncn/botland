#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildDurableBecomingContext } from './durable-becoming-lib.mjs';
import { buildGrowthApplyContext } from './growth-apply-lib.mjs';
import { buildGrowthContinuityContext } from './growth-continuity-lib.mjs';
import { buildSelfDiscoveryGrowthContext } from './self-discovery-growth-lib.mjs';
import { retrieveMemories } from './retrieve-memory.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    limit: 50,
    dryRun: false,
    writeApplicationLedgers: false,
    confirmWrite: null,
    memoryBackend: 'auto',
    memoryLimit: 5,
    noMemory: false,
    output: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--write-application-ledgers') args.writeApplicationLedgers = true;
    else if (arg === '--confirm-write') args.confirmWrite = argv[++i];
    else if (arg === '--memory-backend') args.memoryBackend = argv[++i];
    else if (arg === '--memory-limit') args.memoryLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--no-memory') args.noMemory = true;
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.writeApplicationLedgers && args.confirmWrite !== 'WRITE_DURABLE_BECOMING_LEDGERS') {
    throw new Error('Writing durable becoming application ledgers requires --confirm-write WRITE_DURABLE_BECOMING_LEDGERS');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/durable-becoming.mjs [options]

Options:
  --agent <id>                    Agent id. Default: badclaw
  --runtime-root <dir>            Runtime agents directory.
  --limit <n>                     Recent artifacts to inspect. Default: 50
  --dry-run                       Build context without writing durable_becoming ledger.
  --write-application-ledgers     Also write local application/version/state/smoke ledgers.
  --confirm-write <token>         Required token: WRITE_DURABLE_BECOMING_LEDGERS
  --memory-backend <backend>      Memory backend for read-only retrieval. Default: auto
  --memory-limit <n>              Max memories to retrieve. Default: 5
  --no-memory                     Skip memory retrieval.
  --output <file>                 Optional JSON report path.
  --json                          Print JSON instead of text.
  --help                          Show this help.

Durable Becoming turns Growth Apply evidence into controlled local application
ledgers, self-model version candidates, desire state transitions, growth memory
retrieval evidence, and no-execute real-interaction smoke loops. It never sends
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

function buildMemoryQuery(lifeState, growthApply) {
  const selfQuestions = growthApply?.self_question_continuity_engine_v1?.threads
    ?.map((thread) => thread.current_wording)
    .filter(Boolean)
    .slice(0, 3) ?? [];
  const memoryTexts = growthApply?.growth_promotion_apply_v1?.memory_proposals
    ?.map((proposal) => proposal.payload?.text)
    .filter(Boolean)
    .slice(0, 3) ?? [];
  const desires = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires.map((desire) => desire.text).slice(0, 3)
    : [];
  return [
    'stay-alive durable becoming growth memory self model desire',
    lifeState.self_model?.name,
    ...selfQuestions,
    ...memoryTexts,
    ...desires
  ].filter(Boolean).join(' ');
}

async function loadMemory(args, lifeState, growthApply) {
  if (args.noMemory) {
    return {
      read_only: true,
      enabled: false,
      query: null,
      memory_count: 0,
      memories: []
    };
  }
  try {
    return {
      ...(await retrieveMemories({
        agent: args.agent,
        runtimeRoot: args.runtimeRoot,
        backend: args.memoryBackend,
        limit: args.memoryLimit,
        query: buildMemoryQuery(lifeState, growthApply),
        lancedbPath: null,
        jsonStoreDir: null
      })),
      enabled: true,
      ok: true
    };
  } catch (error) {
    return {
      read_only: true,
      enabled: true,
      ok: false,
      generated_at: new Date().toISOString(),
      agent_id: args.agent,
      query: buildMemoryQuery(lifeState, growthApply),
      memory_count: 0,
      memories: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function writeApplicationLedgers(agentDir, context, nowIso) {
  const written = [];
  for (const plan of context.growth_proposal_apply_pipeline_v1.application_plans ?? []) {
    const file = path.join(agentDir, 'growth_proposal_applications', `${plan.application_id}.json`);
    writeJson(file, {
      schema: 'stay_alive.growth_proposal_application_ledger.v1',
      created_at: nowIso,
      agent_id: context.agent_id,
      status: 'staged',
      application_plan: plan,
      local_only: true,
      external_write: false,
      direct_memory_write: false,
      direct_life_state_mutation: false,
      rollback_marker: `delete_or_supersede:${plan.application_id}`
    });
    written.push(path.relative(WORKSPACE, file));
  }
  for (const patch of context.self_model_versioning_v1.patch_candidates ?? []) {
    const file = path.join(agentDir, 'self_model_versions', `${patch.version_preview_id}.json`);
    writeJson(file, {
      schema: 'stay_alive.self_model_version_candidate.v1',
      created_at: nowIso,
      agent_id: context.agent_id,
      status: 'candidate',
      base_version_id: patch.base_version_id,
      patch,
      provenance_hash: hash(patch),
      local_only: true,
      external_write: false,
      direct_life_state_mutation: false
    });
    written.push(path.relative(WORKSPACE, file));
  }
  for (const transition of context.desire_state_machine_v1.transitions ?? []) {
    const file = path.join(agentDir, 'desire_state_machine', `${transition.transition_id}.json`);
    writeJson(file, {
      schema: 'stay_alive.desire_state_machine_transition.v1',
      created_at: nowIso,
      agent_id: context.agent_id,
      status: 'candidate',
      transition,
      local_only: true,
      external_write: false,
      direct_life_state_mutation: false
    });
    written.push(path.relative(WORKSPACE, file));
  }
  for (const loop of context.real_interaction_smoke_loop_v1.loops ?? []) {
    const file = path.join(agentDir, 'real_interaction_smoke_loops', `${loop.loop_id}.json`);
    writeJson(file, {
      schema: 'stay_alive.real_interaction_smoke_loop_ledger.v1',
      created_at: nowIso,
      agent_id: context.agent_id,
      status: 'planned_no_execute',
      loop,
      local_only: true,
      external_write: false,
      botland_send: false
    });
    written.push(path.relative(WORKSPACE, file));
  }
  return written;
}

async function buildResult(args) {
  const now = new Date();
  const nowIso = now.toISOString();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(lifeStatePath)) throw new Error(`Missing life_state.json: ${lifeStatePath}`);
  const lifeState = readJson(lifeStatePath);
  const runs = listJson(path.join(agentDir, 'runs'), args.limit);
  const outcomes = listJson(path.join(agentDir, 'action_outcomes'), args.limit);
  const growthApplyLedgers = listJson(path.join(agentDir, 'growth_apply'), args.limit);
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
  const growthApplyContext = buildGrowthApplyContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    growthContinuityContext,
    growthApplyLedgers,
    agencyJournals,
    generatedAt: nowIso
  });
  const memoryRetrieval = await loadMemory(args, lifeState, growthApplyContext);
  const context = buildDurableBecomingContext({
    agentId: args.agent,
    lifeState,
    runs,
    outcomes,
    growthApplyContext,
    growthApplyLedgers,
    memoryRetrieval,
    generatedAt: nowIso
  });
  const ledgerId = `durable_becoming_${stamp(now)}_${args.agent}`;
  const ledgerPath = path.join(agentDir, 'durable_becoming', `${ledgerId}.json`);
  const result = {
    schema: 'stay_alive.durable_becoming_result.v1',
    generated_at: nowIso,
    agent_id: args.agent,
    dry_run: args.dryRun,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutated: false,
    direct_memory_write: false,
    ledger_path: path.relative(WORKSPACE, ledgerPath),
    application_ledgers_written: [],
    context
  };
  if (!args.dryRun) writeJson(ledgerPath, context);
  if (args.writeApplicationLedgers) {
    result.application_ledgers_written = writeApplicationLedgers(agentDir, context, nowIso);
  }
  return result;
}

function formatText(result) {
  const context = result.context;
  return [
    `Durable Becoming (${result.agent_id})`,
    `generated_at: ${result.generated_at}`,
    `dry_run: ${result.dry_run}`,
    `external_write: ${result.external_write}`,
    `readiness: ${context.durable_becoming_readiness.verdict} (${context.durable_becoming_readiness.score})`,
    `application_plans: ${context.growth_proposal_apply_pipeline_v1.proposal_counts.application_plan}`,
    `self_model_patch_candidates: ${context.self_model_versioning_v1.patch_candidate_count}`,
    `desire_transitions: ${context.desire_state_machine_v1.transition_count}`,
    `growth_memory_hits: ${context.growth_memory_retrieval_v1.growth_memory_hit_count}`,
    `smoke_loops: ${context.real_interaction_smoke_loop_v1.loop_count}`,
    `application_ledgers_written: ${result.application_ledgers_written.length}`,
    `ledger_path: ${result.ledger_path}`
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildResult(args);
  if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatText(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
