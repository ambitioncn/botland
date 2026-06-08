#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { assertMutationAllowed } from './life-state-mutation-protocol-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const ALLOWED_STATUSES = new Set(['active', 'paused', 'fulfilled', 'dismissed', 'expired']);

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    desireHash: null,
    confirmApply: null,
    dryRun: true,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--desire-hash') args.desireHash = argv[++i];
    else if (arg === '--confirm-apply') {
      args.confirmApply = argv[++i];
      args.dryRun = false;
    } else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.desireHash) throw new Error('--desire-hash is required');
  if (!args.dryRun && args.confirmApply !== 'APPLY_DESIRE_LIFECYCLE') {
    throw new Error('Desire lifecycle apply requires --confirm-apply APPLY_DESIRE_LIFECYCLE');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/apply-desire-lifecycle.mjs --desire-hash <hash> [options]

Apply an approved desire lifecycle ledger to life_state.current_desires. This
only changes local desire status/review fields and never sends BotLand messages.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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

function validateLifecycleLedger(ledger) {
  const payload = ledger.payload ?? {};
  if (payload.type !== 'stay_alive_desire_lifecycle_candidate') {
    throw new Error(`Unsupported desire lifecycle ledger type: ${payload.type ?? 'missing'}`);
  }
  if (payload.lifecycle_allowed !== true || payload.promotion_target !== 'life_state.current_desires') {
    throw new Error('Refusing non-lifecycle desire candidate');
  }
  if (typeof payload.desire_id !== 'string' || payload.desire_id.length === 0) {
    throw new Error('Desire lifecycle candidate must include desire_id');
  }
  if (!ALLOWED_STATUSES.has(payload.next_status)) {
    throw new Error(`Unsupported next_status: ${payload.next_status ?? 'missing'}`);
  }
  return payload;
}

function lifecycleAlreadyExists(agentDir, desireHash) {
  const dir = path.join(agentDir, 'desire_lifecycle');
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .some((action) => action.desire_hash === desireHash && action.status === 'applied');
}

function buildLifecycle(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const desireUpdatePath = path.join(agentDir, 'desire_updates', `${args.desireHash}.json`);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(desireUpdatePath)) throw new Error(`Desire update not found: ${desireUpdatePath}`);
  const ledger = readJson(desireUpdatePath);
  const payload = validateLifecycleLedger(ledger);
  const lifeState = readJson(lifeStatePath);
  const desires = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const existing = desires.find((desire) => desire.id === payload.desire_id);
  if (!existing) throw new Error(`Desire not found in life_state.current_desires: ${payload.desire_id}`);
  const reviewedAt = payload.last_reviewed_at ?? new Date().toISOString();
  const nextDesire = {
    ...existing,
    status: payload.next_status,
    horizon: payload.horizon ?? existing.horizon ?? 'medium',
    priority: payload.priority ?? existing.priority ?? 'medium',
    related_relationships: payload.related_relationships ?? existing.related_relationships ?? [],
    related_commitments: payload.related_commitments ?? existing.related_commitments ?? [],
    success_signal: payload.success_signal ?? existing.success_signal ?? null,
    expires_at: payload.expires_at ?? existing.expires_at ?? existing.expiry ?? null,
    last_reviewed_at: reviewedAt,
    updated_at: reviewedAt,
    lifecycle: {
      ...(existing.lifecycle ?? {}),
      last_lifecycle_update_hash: args.desireHash,
      last_lifecycle_reason: payload.evidence?.reason ?? null
    }
  };
  return { agentDir, desireUpdatePath, lifeStatePath, ledger, payload, lifeState, existing, nextDesire };
}

function applyLifecycle(args, plan) {
  const now = new Date();
  const preflightGate = runPreflight(args);
  const mutation_gate = assertMutationAllowed({
    actor: 'lifecycle_evolution',
    path: 'current_desires',
    operation: 'apply_desire_lifecycle',
    evidence: {
      desire_hash: args.desireHash,
      desire_update_path: path.relative(WORKSPACE, plan.desireUpdatePath),
      preflight_pass: preflightGate.pass
    }
  });
  const desires = Array.isArray(plan.lifeState.current_desires) ? plan.lifeState.current_desires : [];
  writeJson(plan.lifeStatePath, {
    ...plan.lifeState,
    current_desires: desires.map((desire) => desire.id === plan.existing.id ? plan.nextDesire : desire),
    updated_at: now.toISOString()
  });
  const actionId = stamp('desire_lifecycle', now);
  const actionPath = path.join(plan.agentDir, 'desire_lifecycle', `${actionId}.json`);
  const action = {
    action_id: actionId,
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: 'applied',
    dry_run: false,
    desire_hash: args.desireHash,
    desire_update_path: path.relative(WORKSPACE, plan.desireUpdatePath),
    preflight_gate: preflightGate,
    mutation_gate,
    desire_id: plan.nextDesire.id,
    previous_status: plan.existing.status ?? null,
    next_status: plan.nextDesire.status,
    local_only: true,
    external_write: false,
    result: {
      ok: true,
      external_write: false,
      changed_files: [
        path.relative(WORKSPACE, plan.lifeStatePath),
        path.relative(WORKSPACE, actionPath)
      ]
    }
  };
  writeJson(actionPath, action);
  return action;
}

function formatText(report) {
  return [
    `Stay-Alive desire lifecycle apply (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `dry_run: ${report.dry_run ? 'yes' : 'no'}`,
    `desire_hash: ${report.desire_hash}`,
    `desire_id: ${report.desire_id}`,
    `status: ${report.previous_status ?? 'unknown'} -> ${report.next_status}`,
    `changed_files: ${report.changed_files.join(', ') || 'none'}`,
    'external_write: no',
    'botland_send: no'
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildLifecycle(args);
  if (lifecycleAlreadyExists(plan.agentDir, args.desireHash)) {
    throw new Error(`Desire lifecycle update ${args.desireHash} has already been applied`);
  }
  const report = {
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    desire_hash: args.desireHash,
    desire_update_path: path.relative(WORKSPACE, plan.desireUpdatePath),
    desire_id: plan.nextDesire.id,
    previous_status: plan.existing.status ?? null,
    next_status: plan.nextDesire.status,
    desire_preview: plan.nextDesire,
    changed_files: [],
    local_only: true,
    external_write: false
  };
  if (!args.dryRun) {
    const action = applyLifecycle(args, plan);
    report.action_id = action.action_id;
    report.changed_files = action.result.changed_files;
  }
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
