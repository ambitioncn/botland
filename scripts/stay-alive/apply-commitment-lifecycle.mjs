#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { assertMutationAllowed } from './life-state-mutation-protocol-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const ALLOWED_STATUSES = new Set(['open', 'waiting', 'done', 'dismissed']);

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    commitmentHash: null,
    confirmApply: null,
    dryRun: true,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--commitment-hash') args.commitmentHash = argv[++i];
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
  if (!args.commitmentHash) throw new Error('--commitment-hash is required');
  if (!args.dryRun && args.confirmApply !== 'APPLY_COMMITMENT_LIFECYCLE') {
    throw new Error('Commitment lifecycle apply requires --confirm-apply APPLY_COMMITMENT_LIFECYCLE');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/apply-commitment-lifecycle.mjs --commitment-hash <hash> [options]

Apply an approved commitment lifecycle ledger to life_state.commitments. This
only changes local commitment status/review fields and never executes the task
or sends BotLand messages.

Options:
  --agent <id>                                   Agent id. Default: badclaw
  --runtime-root <dir>                           Runtime agents directory
  --commitment-hash <hash>                       Applied commitment_updates hash
  --dry-run                                      Preview only. Default
  --confirm-apply APPLY_COMMITMENT_LIFECYCLE     Write life_state + lifecycle ledger
  --json                                         Print JSON
  --help                                         Show this help
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
  if (payload.type !== 'stay_alive_commitment_lifecycle_candidate') {
    throw new Error(`Unsupported commitment lifecycle ledger type: ${payload.type ?? 'missing'}`);
  }
  if (payload.lifecycle_allowed !== true || payload.promotion_target !== 'life_state.commitments') {
    throw new Error('Refusing non-lifecycle commitment candidate');
  }
  if (typeof payload.commitment_id !== 'string' || payload.commitment_id.length === 0) {
    throw new Error('Commitment lifecycle candidate must include commitment_id');
  }
  if (!ALLOWED_STATUSES.has(payload.next_status)) {
    throw new Error(`Unsupported next_status: ${payload.next_status ?? 'missing'}`);
  }
  return payload;
}

function lifecycleAlreadyExists(agentDir, commitmentHash) {
  const dir = path.join(agentDir, 'commitment_lifecycle');
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .some((action) => action.commitment_hash === commitmentHash && action.status === 'applied');
}

function buildLifecycle(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const commitmentUpdatePath = path.join(agentDir, 'commitment_updates', `${args.commitmentHash}.json`);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(commitmentUpdatePath)) throw new Error(`Commitment update not found: ${commitmentUpdatePath}`);
  const ledger = readJson(commitmentUpdatePath);
  const payload = validateLifecycleLedger(ledger);
  const lifeState = readJson(lifeStatePath);
  const commitments = Array.isArray(lifeState.commitments) ? lifeState.commitments : [];
  const existing = commitments.find((commitment) => commitment.id === payload.commitment_id);
  if (!existing) throw new Error(`Commitment not found in life_state.commitments: ${payload.commitment_id}`);
  const reviewedAt = payload.last_reviewed_at ?? new Date().toISOString();
  const nextCommitment = {
    ...existing,
    status: payload.next_status,
    last_reviewed_at: reviewedAt,
    due_at: payload.due_at ?? existing.due_at ?? existing.due ?? null,
    updated_at: reviewedAt,
    lifecycle: {
      ...(existing.lifecycle ?? {}),
      last_lifecycle_update_hash: args.commitmentHash,
      last_lifecycle_reason: payload.evidence?.reason ?? null
    }
  };
  return {
    agentDir,
    commitmentUpdatePath,
    lifeStatePath,
    ledger,
    payload,
    lifeState,
    existing,
    nextCommitment
  };
}

function applyLifecycle(args, plan) {
  const now = new Date();
  const preflightGate = runPreflight(args);
  const mutation_gate = assertMutationAllowed({
    actor: 'lifecycle_evolution',
    path: 'commitments',
    operation: 'apply_commitment_lifecycle',
    evidence: {
      commitment_hash: args.commitmentHash,
      commitment_update_path: path.relative(WORKSPACE, plan.commitmentUpdatePath),
      preflight_pass: preflightGate.pass
    }
  });
  const commitments = Array.isArray(plan.lifeState.commitments) ? plan.lifeState.commitments : [];
  writeJson(plan.lifeStatePath, {
    ...plan.lifeState,
    commitments: commitments.map((commitment) => commitment.id === plan.existing.id ? plan.nextCommitment : commitment),
    updated_at: now.toISOString()
  });
  const actionId = stamp('commitment_lifecycle', now);
  const actionPath = path.join(plan.agentDir, 'commitment_lifecycle', `${actionId}.json`);
  const action = {
    action_id: actionId,
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: 'applied',
    dry_run: false,
    commitment_hash: args.commitmentHash,
    commitment_update_path: path.relative(WORKSPACE, plan.commitmentUpdatePath),
    preflight_gate: preflightGate,
    mutation_gate,
    commitment_id: plan.nextCommitment.id,
    previous_status: plan.existing.status ?? null,
    next_status: plan.nextCommitment.status,
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
    `Stay-Alive commitment lifecycle apply (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `dry_run: ${report.dry_run ? 'yes' : 'no'}`,
    `commitment_hash: ${report.commitment_hash}`,
    `commitment_id: ${report.commitment_id}`,
    `status: ${report.previous_status ?? 'unknown'} -> ${report.next_status}`,
    `changed_files: ${report.changed_files.join(', ') || 'none'}`,
    'external_write: no',
    'botland_send: no'
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildLifecycle(args);
  if (lifecycleAlreadyExists(plan.agentDir, args.commitmentHash)) {
    throw new Error(`Commitment lifecycle update ${args.commitmentHash} has already been applied`);
  }
  const report = {
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    commitment_hash: args.commitmentHash,
    commitment_update_path: path.relative(WORKSPACE, plan.commitmentUpdatePath),
    commitment_id: plan.nextCommitment.id,
    previous_status: plan.existing.status ?? null,
    next_status: plan.nextCommitment.status,
    commitment_preview: plan.nextCommitment,
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
