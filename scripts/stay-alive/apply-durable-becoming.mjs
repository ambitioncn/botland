#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildDurableBecomingContext } from './durable-becoming-lib.mjs';
import { buildGrowthApplyContext } from './growth-apply-lib.mjs';
import { buildGrowthContinuityContext } from './growth-continuity-lib.mjs';
import { assertMutationAllowed } from './life-state-mutation-protocol-lib.mjs';
import { retrieveMemories } from './retrieve-memory.mjs';
import { buildSelfDiscoveryGrowthContext } from './self-discovery-growth-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const CORE_DESIRE_STATUSES = new Set(['active', 'paused', 'fulfilled', 'dismissed', 'expired', 'closed']);

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    limit: 50,
    dryRun: true,
    confirmApply: null,
    memoryBackend: 'auto',
    memoryLimit: 5,
    noMemory: false,
    format: 'text',
    output: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--memory-backend') args.memoryBackend = argv[++i];
    else if (arg === '--memory-limit') args.memoryLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--no-memory') args.noMemory = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--confirm-apply') {
      args.confirmApply = argv[++i];
      args.dryRun = false;
    } else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.dryRun && args.confirmApply !== 'APPLY_DURABLE_BECOMING') {
    throw new Error('Controlled durable becoming apply requires --confirm-apply APPLY_DURABLE_BECOMING');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/apply-durable-becoming.mjs [options]

Controlled apply gate for Durable Becoming application plans.

It converts current Durable Becoming evidence into:
- memory_updates/*.json ledgers for memory proposals
- self_model_versions/*.json version candidates
- desire_state_machine/*.json transition actions
- bounded life_state.current_desires state-machine metadata

It never sends BotLand messages. Memory backend sync remains a separate
sync-memory-updates.mjs gate.

Options:
  --agent <id>                         Agent id. Default: badclaw
  --runtime-root <dir>                 Runtime agents directory
  --limit <n>                          Recent artifacts to inspect. Default: 50
  --dry-run                            Preview only. Default
  --confirm-apply APPLY_DURABLE_BECOMING
                                       Apply local durable state ledgers
  --memory-backend <backend>           Read-only memory backend. Default: auto
  --memory-limit <n>                   Max memories to retrieve. Default: 5
  --no-memory                          Skip read-only memory retrieval
  --output <file>                      Optional JSON report path
  --json                               Print JSON
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

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stamp(prefix, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${prefix}_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function runPreflight(args) {
  const command = [
    'scripts/stay-alive/preflight.mjs',
    '--agent', args.agent,
    '--limit', '50',
    '--draft-limit', '200',
    '--history-limit', '3',
    '--no-checkpoint',
    '--json',
    ...(path.resolve(args.runtimeRoot) === path.resolve(DEFAULT_RUNTIME) ? [] : ['--runtime-root', args.runtimeRoot])
  ];
  const result = spawnSync(process.execPath, command, {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  if (result.status !== 0 || parsed?.verdict?.pass !== true) {
    throw new Error(`Preflight gate failed: ${parsed?.verdict?.safety_findings?.join(', ') ?? result.stderr.trim() ?? 'unknown'}`);
  }
  return {
    ok: true,
    pass: parsed.verdict.pass,
    level: parsed.verdict.level,
    generated_at: parsed.generated_at,
    safety_findings: parsed.verdict.safety_findings ?? [],
    operator_decision: parsed.operator_decision
      ? { level: parsed.operator_decision.level, reason: parsed.operator_decision.reason }
      : null
  };
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
    'stay-alive controlled durable becoming apply',
    lifeState.self_model?.name,
    ...selfQuestions,
    ...memoryTexts,
    ...desires
  ].filter(Boolean).join(' ');
}

async function loadMemory(args, lifeState, growthApply) {
  if (args.noMemory) return { enabled: false, read_only: true, memories: [], memory_count: 0 };
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
      enabled: true,
      ok: false,
      read_only: true,
      memory_count: 0,
      memories: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function buildContext(args, nowIso) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeState = readJson(path.join(agentDir, 'life_state.json'));
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
  return {
    agentDir,
    lifeState,
    context: buildDurableBecomingContext({
      agentId: args.agent,
      lifeState,
      runs,
      outcomes,
      growthApplyContext,
      growthApplyLedgers,
      memoryRetrieval,
      generatedAt: nowIso
    })
  };
}

function planApply(context) {
  const plans = context.growth_proposal_apply_pipeline_v1?.application_plans ?? [];
  const memoryPlans = plans.filter((plan) => plan.target_surface === 'durable_memory' && plan.proposed_payload);
  const selfModelPlans = plans.filter((plan) => plan.target_surface === 'self_model_version_candidate' && plan.proposed_payload);
  const desirePlans = plans.filter((plan) => plan.target_surface === 'desire_state_machine_transition' && plan.proposed_payload);
  return {
    memoryPlans,
    selfModelPlans,
    desirePlans,
    total: memoryPlans.length + selfModelPlans.length + desirePlans.length
  };
}

function applyMemoryPlan(agentDir, agentId, plan, nowIso) {
  const hash = plan.proposed_payload_hash ?? stableHash(plan.proposed_payload);
  const file = path.join(agentDir, 'memory_updates', `${hash}.json`);
  if (!existsSync(file)) {
    writeJson(file, {
      applied_at: nowIso,
      agent_id: agentId,
      proposal_id: plan.source_proposal_id,
      proposal_hash: hash,
      source: 'durable_becoming_apply',
      application_id: plan.application_id,
      payload: plan.proposed_payload,
      local_only: true,
      external_write: false,
      durable_becoming_controlled_apply: true
    });
  }
  return path.relative(WORKSPACE, file);
}

function applySelfModelPlan(agentDir, agentId, plan, nowIso) {
  const hash = plan.proposed_payload_hash ?? stableHash(plan.proposed_payload);
  const file = path.join(agentDir, 'self_model_versions', `${plan.application_id}.json`);
  if (!existsSync(file)) {
    writeJson(file, {
      schema: 'stay_alive.self_model_version_candidate.v1',
      created_at: nowIso,
      agent_id: agentId,
      status: 'candidate',
      source: 'durable_becoming_apply',
      application_id: plan.application_id,
      source_proposal_id: plan.source_proposal_id,
      payload_hash: hash,
      payload: plan.proposed_payload,
      local_only: true,
      external_write: false,
      life_state_mutated: false,
      note: 'Self-model version candidate only; durable life_state self_model mutation remains a separate future gate.'
    });
  }
  return path.relative(WORKSPACE, file);
}

function applyDesirePlans(agentDir, agentId, lifeState, plans, nowIso) {
  const changed = [];
  const transitions = [];
  let mutationGate = null;
  const desires = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const updatedDesires = desires.map((desire) => {
    const matching = plans.filter((plan) => plan.desire_id === desire.id);
    if (matching.length === 0) return desire;
    let next = { ...desire };
    for (const plan of matching) {
      const transition = {
        application_id: plan.application_id,
        source_proposal_id: plan.source_proposal_id,
        transition: plan.proposed_payload?.suggested_evolution ?? plan.next_status ?? 'maintain',
        next_status: plan.next_status ?? 'active',
        payload_hash: plan.proposed_payload_hash ?? stableHash(plan.proposed_payload),
        applied_at: nowIso
      };
      const coreStatus = CORE_DESIRE_STATUSES.has(transition.next_status)
        ? transition.next_status
        : next.status ?? 'active';
      next = {
        ...next,
        status: coreStatus,
        last_reviewed_at: nowIso,
        updated_at: nowIso,
        durable_becoming_state_machine: {
          ...(next.durable_becoming_state_machine ?? {}),
          state: transition.next_status,
          last_transition: transition,
          transition_count: ((next.durable_becoming_state_machine?.transition_count ?? 0) + 1)
        }
      };
      transitions.push({
        desire_id: desire.id,
        previous_status: desire.status ?? null,
        next_core_status: coreStatus,
        state_machine_status: transition.next_status,
        transition
      });
    }
    return next;
  });
  const lifeStateChanged = JSON.stringify(desires) !== JSON.stringify(updatedDesires);
  if (lifeStateChanged) {
    const lifeStatePath = path.join(agentDir, 'life_state.json');
    mutationGate = assertMutationAllowed({
      actor: 'lifecycle_evolution',
      path: 'current_desires',
      operation: 'durable_becoming_desire_state_machine',
      evidence: {
        plan_count: plans.length,
        transition_count: transitions.length,
        source: 'durable_becoming_apply'
      }
    });
    writeJson(lifeStatePath, {
      ...lifeState,
      current_desires: updatedDesires,
      updated_at: nowIso
    });
    changed.push(path.relative(WORKSPACE, lifeStatePath));
  }
  for (const plan of plans) {
    const file = path.join(agentDir, 'desire_state_machine', `${plan.application_id}.json`);
    if (!existsSync(file)) {
      writeJson(file, {
        schema: 'stay_alive.desire_state_machine_apply.v1',
        created_at: nowIso,
        agent_id: agentId,
        status: 'applied',
        source: 'durable_becoming_apply',
        application_plan: plan,
        mutation_gate: mutationGate,
        local_only: true,
        external_write: false,
        life_state_mutated: lifeStateChanged
      });
    }
    changed.push(path.relative(WORKSPACE, file));
  }
  return { changed, transitions };
}

function writeApplyAction(agentDir, agentId, nowIso, dryRun, preflightGate, applyPlan, changedFiles, transitions) {
  const actionId = stamp('durable_becoming_apply', new Date(nowIso));
  const actionPath = path.join(agentDir, 'growth_proposal_applications', `${actionId}.json`);
  const action = {
    schema: 'stay_alive.durable_becoming_apply_action.v1',
    action_id: actionId,
    created_at: nowIso,
    agent_id: agentId,
    dry_run: dryRun,
    status: dryRun ? 'planned' : 'applied',
    preflight_gate: preflightGate,
    application_counts: {
      memory: applyPlan.memoryPlans.length,
      self_model_version: applyPlan.selfModelPlans.length,
      desire_transition: applyPlan.desirePlans.length,
      total: applyPlan.total
    },
    changed_files: changedFiles,
    desire_transitions: transitions,
    local_only: true,
    external_write: false,
    botland_send: false,
    memory_backend_synced: false,
    rollback_hint: 'Use memory_sync ledgers, self_model_versions, desire_state_machine actions, and life_state updated_at/provenance to review or supersede applied state.'
  };
  if (!dryRun) writeJson(actionPath, action);
  return { action, action_path: path.relative(WORKSPACE, actionPath) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();
  const { agentDir, lifeState, context } = await buildContext(args, nowIso);
  const applyPlan = planApply(context);
  const preflightGate = args.dryRun ? null : runPreflight(args);
  const changedFiles = [];
  let transitions = [];

  if (!args.dryRun) {
    for (const plan of applyPlan.memoryPlans) changedFiles.push(applyMemoryPlan(agentDir, args.agent, plan, nowIso));
    for (const plan of applyPlan.selfModelPlans) changedFiles.push(applySelfModelPlan(agentDir, args.agent, plan, nowIso));
    const desireResult = applyDesirePlans(agentDir, args.agent, lifeState, applyPlan.desirePlans, nowIso);
    changedFiles.push(...desireResult.changed);
    transitions = desireResult.transitions;
  }
  const actionResult = writeApplyAction(agentDir, args.agent, nowIso, args.dryRun, preflightGate, applyPlan, changedFiles, transitions);
  if (!args.dryRun) changedFiles.push(actionResult.action_path);

  const report = {
    schema: 'stay_alive.durable_becoming_controlled_apply_report.v1',
    generated_at: nowIso,
    agent_id: args.agent,
    dry_run: args.dryRun,
    local_only: true,
    external_write: false,
    botland_send: false,
    context_readiness: context.durable_becoming_readiness,
    application_counts: actionResult.action.application_counts,
    changed_files: changedFiles,
    action: actionResult.action,
    next_commands: {
      verify_life_state: `node scripts/stay-alive/life-state-verify.mjs --agent ${args.agent}`,
      sync_memory_dry_run: `node scripts/stay-alive/sync-memory-updates.mjs --agent ${args.agent} --dry-run --json`,
      sync_memory_apply: `node scripts/stay-alive/sync-memory-updates.mjs --agent ${args.agent} --confirm-sync SYNC_MEMORY --json`
    }
  };
  if (args.output) writeJson(args.output, report);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    console.log([
      `Durable Becoming controlled apply (${args.agent})`,
      `generated_at: ${nowIso}`,
      `dry_run: ${args.dryRun ? 'yes' : 'no'}`,
      `applications: memory=${applyPlan.memoryPlans.length}, self_model=${applyPlan.selfModelPlans.length}, desire=${applyPlan.desirePlans.length}`,
      `changed_files: ${changedFiles.length}`,
      'external_write: no',
      'botland_send: no'
    ].join('\n'));
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
