#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE,
  agentDir,
  stamp,
  writeJson
} from './proposal-lib.mjs';
import { buildGovernancePlan, runtimeRootArgs } from './proposal-governance-lib.mjs';

const CONFIRM_TOKEN = 'RUN_LOCAL_GOVERNANCE';

const UNIVERSAL_POLICY = {
  policy_id: 'universal',
  description: 'general stay-alive local governance shared by every agent',
  applyMax: 10,
  dismissMax: 20,
  traceLimit: 100,
  patchLimit: 24,
  memoryLimit: 220,
  memoryBackend: 'auto'
};

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    style: 'auto',
    execute: false,
    confirmGovernance: null,
    skipPreflight: false,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--style') args.style = argv[++i];
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--confirm-governance') args.confirmGovernance = argv[++i];
    else if (arg === '--skip-preflight') args.skipPreflight = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['auto', 'default', 'universal'].includes(args.style)) {
    throw new Error('--style is deprecated; use auto/default/universal only. Agent-specific governance styles are not supported.');
  }
  if (args.execute && args.confirmGovernance !== CONFIRM_TOKEN) {
    throw new Error(`--confirm-governance ${CONFIRM_TOKEN} is required with --execute`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/local-governance-cycle.mjs [options]

Options:
  --agent <id>                 Agent id. Default: badclaw
  --runtime-root <dir>         Runtime agents directory.
  --style <style|auto>         Deprecated compatibility option. Only auto/default/universal.
  --execute                    Execute local governance. Default is dry-run.
  --confirm-governance ${CONFIRM_TOKEN}
                               Execution guard required with --execute.
  --skip-preflight             Skip preflight gate. Intended for isolated tests only.
  --json                       Print JSON.
  --help                       Show this help.

This is the common autonomous local-governance cycle for Stay-Alive agents. It
may apply/dismiss safe local proposals, sync already-applied memory proposals to
the configured memory backend, write trace reviews, and write planner patch
ledgers. It never calls BotLand send/post/reply/join/report/profile writes,
never promotes relationship/commitment/desire state, and never bypasses the
existing proposal gates for any life_state change. The confirm token is an
execution guard for scripts/timers, not a human per-action confirmation step.
`);
}

function resolvePolicy(args) {
  return {
    ...UNIVERSAL_POLICY,
    deprecated_style_arg: args.style,
    agent_specific_policy: false
  };
}

function runJson(script, argv, options = {}) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    name: options.name ?? path.basename(script, '.mjs'),
    command: [process.execPath, script, ...argv].join(' '),
    status: result.status,
    ok: result.status === 0,
    stdout_json: parsed,
    stdout_tail: parsed ? null : tail(result.stdout),
    stderr_tail: tail(result.stderr)
  };
}

function tail(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.split(/\r?\n/).slice(-12).join('\n');
}

function preflightStep(args) {
  if (args.skipPreflight) {
    return {
      name: 'preflight',
      skipped: true,
      ok: true,
      reason: 'skip_preflight_requested'
    };
  }
  const step = runJson('scripts/stay-alive/preflight.mjs', [
    '--agent', args.agent,
    '--limit', '80',
    ...runtimeRootArgs(args.runtimeRoot),
    '--no-checkpoint',
    '--json'
  ], { name: 'preflight' });
  const pass = step.stdout_json?.verdict?.pass === true || step.stdout_json?.pass === true;
  return {
    ...step,
    ok: step.ok && pass,
    pass,
    level: step.stdout_json?.verdict?.level ?? step.stdout_json?.level ?? null,
    operator_decision: step.stdout_json?.operator_decision?.level ?? null
  };
}

function governancePreview(args, policy) {
  const plan = buildGovernancePlan({
    agent: args.agent,
    runtimeRoot: args.runtimeRoot,
    limit: Math.max(policy.memoryLimit, policy.traceLimit)
  });
  return {
    proposal_count: plan.proposal_count,
    visible_count: plan.visible_count,
    executable_count: plan.executable_count,
    review_count: plan.review_count,
    counts_by_decision: plan.counts_by_decision,
    counts_by_lane: plan.counts_by_lane,
    apply_candidate_count: plan.proposals.filter((item) => ['approve_apply', 'apply'].includes(item.decision)).length,
    dismiss_candidate_count: plan.proposals.filter((item) => item.decision === 'dismiss').length
  };
}

function buildSteps(args, policy) {
  const commonRoot = runtimeRootArgs(args.runtimeRoot);
  const dryRunFlag = args.execute ? [] : ['--dry-run'];
  const steps = [];

  steps.push(runJson('scripts/stay-alive/proposal-batch.mjs', [
    '--agent', args.agent,
    ...commonRoot,
    '--limit', String(policy.memoryLimit),
    '--mode', 'apply-local',
    '--max', String(policy.applyMax),
    ...(args.execute ? ['--confirm-batch', 'APPLY_LOCAL_PROPOSALS'] : ['--dry-run']),
    '--note', `${policy.policy_id}:apply-local`,
    '--json'
  ], { name: 'proposal_apply_local' }));

  steps.push(runJson('scripts/stay-alive/proposal-batch.mjs', [
    '--agent', args.agent,
    ...commonRoot,
    '--limit', String(policy.memoryLimit),
    '--mode', 'dismiss-stale',
    '--max', String(policy.dismissMax),
    ...(args.execute ? ['--confirm-batch', 'DISMISS_STALE_PROPOSALS'] : ['--dry-run']),
    '--note', `${policy.policy_id}:dismiss-stale`,
    '--json'
  ], { name: 'proposal_dismiss_stale' }));

  steps.push(runJson('scripts/stay-alive/sync-memory-updates.mjs', [
    '--agent', args.agent,
    ...commonRoot,
    '--limit', String(policy.memoryLimit),
    '--backend', policy.memoryBackend,
    ...(args.execute ? ['--confirm-sync', 'SYNC_MEMORY'] : ['--dry-run']),
    '--json'
  ], { name: 'memory_sync' }));

  steps.push(runJson('scripts/stay-alive/trace-review.mjs', [
    '--agent', args.agent,
    ...commonRoot,
    '--limit', String(policy.traceLimit),
    ...dryRunFlag,
    '--json'
  ], { name: 'trace_review' }));

  steps.push(runJson('scripts/stay-alive/planner-heuristic-patches.mjs', [
    '--agent', args.agent,
    ...commonRoot,
    '--limit', String(policy.patchLimit),
    ...dryRunFlag,
    '--json'
  ], { name: 'planner_patches' }));

  return steps;
}

function stepTouchedLifeState(step) {
  const text = JSON.stringify(step?.stdout_json ?? step ?? {});
  return text.includes('/life_state.json') || text.includes('life_state.json');
}

function summarizeMutationBoundary(steps) {
  return {
    life_state_mutation: steps.some(stepTouchedLifeState),
    direct_life_state_mutation: false,
    bounded_reflection_state_update_possible: true,
    durable_relationship_commitment_desire_promotion: false
  };
}

function writeGovernanceLedger(args, policy, preview, preflight, steps, ok, mutationBoundary) {
  const now = new Date();
  const ledger = {
    schema: 'stay_alive.local_governance_cycle.v1',
    action_id: stamp('local_governance', now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    policy_id: policy.policy_id,
    policy_description: policy.description,
    agent_specific_policy: false,
    execute: args.execute,
    local_only: true,
    external_write: false,
    botland_send: false,
    botland_post: false,
    botland_reply: false,
    botland_join: false,
    profile_update: false,
    life_state_mutation: mutationBoundary.life_state_mutation,
    direct_life_state_mutation: mutationBoundary.direct_life_state_mutation,
    bounded_reflection_state_update_possible: mutationBoundary.bounded_reflection_state_update_possible,
    promotion_or_lifecycle_mutation: false,
    preflight,
    governance_preview: preview,
    steps,
    result: {
      ok,
      failed_steps: steps.filter((step) => !step.ok).map((step) => step.name),
      mutation_boundary: mutationBoundary
    }
  };
  const file = path.join(agentDir(args.runtimeRoot, args.agent), 'local_governance', `${ledger.action_id}.json`);
  writeJson(file, ledger);
  return {
    ...ledger,
    ledger_path: path.relative(WORKSPACE, file)
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive local governance (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `policy: ${report.policy.policy_id}`,
    `execute: ${report.execute ? 'yes' : 'no'}`,
    `ok: ${report.ok ? 'yes' : 'no'}`,
    `preflight: ${report.preflight.ok ? 'ok' : 'blocked'}${report.preflight.level ? ` / ${report.preflight.level}` : ''}`,
    `apply_candidates: ${report.governance_preview.apply_candidate_count}`,
    `dismiss_candidates: ${report.governance_preview.dismiss_candidate_count}`,
    report.ledger_path ? `ledger_path: ${report.ledger_path}` : 'ledger_path: dry-run',
    '',
    'Steps'
  ];
  for (const step of report.steps) {
    lines.push(`- ${step.name}: ${step.ok ? 'ok' : 'failed'}`);
  }
  lines.push('');
  lines.push('Safety');
  lines.push('- external_write: no');
  lines.push('- botland_send/post/reply/join/profile: no');
  lines.push(`- life_state_mutation: ${report.mutation_boundary.life_state_mutation ? 'bounded reflection update through proposal gate' : 'no'}`);
  lines.push('- direct_life_state_mutation: no');
  lines.push('- durable promotions: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const policy = resolvePolicy(args);
  const preview = governancePreview(args, policy);
  const preflight = preflightStep(args);
  const steps = preflight.ok ? buildSteps(args, policy) : [];
  const ok = preflight.ok && steps.every((step) => step.ok);
  const mutationBoundary = summarizeMutationBoundary(steps);
  const ledger = args.execute
    ? writeGovernanceLedger(args, policy, preview, preflight, steps, ok, mutationBoundary)
    : null;
  const report = {
    schema: 'stay_alive.local_governance_cycle_report.v1',
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    execute: args.execute,
    read_only: !args.execute,
    local_only: true,
    external_write: false,
    botland_send: false,
    botland_post: false,
    botland_reply: false,
    botland_join: false,
    profile_update: false,
    life_state_mutation: mutationBoundary.life_state_mutation,
    direct_life_state_mutation: mutationBoundary.direct_life_state_mutation,
    bounded_reflection_state_update_possible: mutationBoundary.bounded_reflection_state_update_possible,
    promotion_or_lifecycle_mutation: false,
    mutation_boundary: mutationBoundary,
    policy,
    governance_preview: preview,
    preflight,
    steps,
    ok,
    ledger_id: ledger?.action_id ?? null,
    ledger_path: ledger?.ledger_path ?? null
  };
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
