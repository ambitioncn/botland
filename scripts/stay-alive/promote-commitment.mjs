#!/usr/bin/env node

import { createHash } from 'node:crypto';
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
    confirmPromote: null,
    format: 'text',
    dryRun: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--commitment-hash') args.commitmentHash = argv[++i];
    else if (arg === '--confirm-promote') {
      args.confirmPromote = argv[++i];
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
  if (!args.dryRun && args.confirmPromote !== 'PROMOTE_COMMITMENT') {
    throw new Error('Commitment promotion requires --confirm-promote PROMOTE_COMMITMENT');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/promote-commitment.mjs --commitment-hash <hash> [options]

Promote an applied local commitment candidate ledger into durable
life_state.commitments. This is local-only, runs preflight, and never performs
the commitment or sends BotLand messages.

Options:
  --agent <id>                         Agent id. Default: badclaw
  --runtime-root <dir>                 Runtime agents directory
  --commitment-hash <hash>             Applied commitment_updates hash
  --dry-run                            Preview only. Default
  --confirm-promote PROMOTE_COMMITMENT Write life_state + promotion ledger
  --json                               Print JSON
  --help                               Show this help
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

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function normalizeSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
}

function isIsoDateOrNull(value) {
  return value === null || value === undefined || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
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

function validateCandidate(ledger) {
  const payload = ledger.payload ?? {};
  if (payload.type !== 'stay_alive_commitment_candidate') {
    throw new Error(`Unsupported commitment ledger type: ${payload.type ?? 'missing'}`);
  }
  if (payload.promotion_allowed !== true || payload.promotion_target !== 'life_state.commitments') {
    throw new Error('Refusing non-promotable commitment candidate');
  }
  const status = payload.commitment_status ?? 'open';
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`Unsupported commitment status: ${status}`);
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    throw new Error('Commitment candidate must include text');
  }
  if (!isIsoDateOrNull(payload.due_at ?? payload.due ?? null)) {
    throw new Error('Commitment candidate due_at must be null or ISO time');
  }
  return payload;
}

function existingCommitment(lifeState, payload) {
  const commitments = Array.isArray(lifeState.commitments) ? lifeState.commitments : [];
  const evidenceHash = payload.evidence_hash ?? payload.evidence?.evidence_hash ?? null;
  const text = String(payload.text ?? '').trim().toLowerCase();
  return commitments.find((commitment) => (
    (evidenceHash && commitment.evidence_hash === evidenceHash)
    || (text && String(commitment.text ?? '').trim().toLowerCase() === text)
  )) ?? null;
}

function buildCommitment(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const commitmentPath = path.join(agentDir, 'commitment_updates', `${args.commitmentHash}.json`);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(commitmentPath)) throw new Error(`Commitment update not found: ${commitmentPath}`);
  const ledger = readJson(commitmentPath);
  const payload = validateCandidate(ledger);
  const lifeState = readJson(lifeStatePath);
  const existing = existingCommitment(lifeState, payload);
  const now = new Date();
  const evidenceHash = payload.evidence_hash ?? payload.evidence?.evidence_hash ?? sha256({
    text: payload.text,
    source: payload.source ?? null
  });
  const id = existing?.id ?? `commitment_${args.agent}_${normalizeSlug(evidenceHash).slice(0, 16)}`;
  const nextCommitment = {
    ...(existing ?? {}),
    id,
    text: payload.text.trim(),
    owner: payload.owner ?? existing?.owner ?? { type: 'agent', agent_id: args.agent },
    peer: payload.peer ?? existing?.peer ?? null,
    source: payload.source ?? existing?.source ?? null,
    due_at: payload.due_at ?? payload.due ?? existing?.due_at ?? existing?.due ?? null,
    status: payload.commitment_status ?? existing?.status ?? 'open',
    last_reviewed_at: payload.last_reviewed_at ?? existing?.last_reviewed_at ?? null,
    evidence_hash: evidenceHash,
    created_at: existing?.created_at ?? payload.source?.created_at ?? ledger.applied_at ?? now.toISOString(),
    updated_at: now.toISOString(),
    evidence: {
      ...(existing?.evidence ?? {}),
      ...(payload.evidence ?? {}),
      commitment_update_hash: args.commitmentHash,
      proposal_hash: ledger.proposal_hash ?? args.commitmentHash
    }
  };
  return {
    agentDir,
    commitmentPath,
    lifeStatePath,
    ledger,
    payload,
    lifeState,
    existing,
    nextCommitment
  };
}

function promotionAlreadyExists(agentDir, commitmentHash) {
  const dir = path.join(agentDir, 'commitment_promotions');
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .some((action) => action.commitment_hash === commitmentHash && action.status === 'promoted');
}

function applyPromotion(args, plan) {
  const now = new Date();
  const preflightGate = runPreflight(args);
  const mutation_gate = assertMutationAllowed({
    actor: 'lifecycle_evolution',
    path: 'commitments',
    operation: plan.existing ? 'update_existing_commitment' : 'create_commitment',
    evidence: {
      commitment_hash: args.commitmentHash,
      commitment_update_path: path.relative(WORKSPACE, plan.commitmentPath),
      preflight_pass: preflightGate.pass
    }
  });
  const commitments = Array.isArray(plan.lifeState.commitments) ? plan.lifeState.commitments : [];
  const nextCommitments = plan.existing
    ? commitments.map((commitment) => commitment.id === plan.existing.id ? plan.nextCommitment : commitment)
    : [...commitments, plan.nextCommitment];
  writeJson(plan.lifeStatePath, {
    ...plan.lifeState,
    commitments: nextCommitments,
    updated_at: now.toISOString()
  });
  const actionId = stamp('commitment_promote', now);
  const actionPath = path.join(plan.agentDir, 'commitment_promotions', `${actionId}.json`);
  const action = {
    action_id: actionId,
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: 'promoted',
    dry_run: false,
    commitment_hash: args.commitmentHash,
    commitment_update_path: path.relative(WORKSPACE, plan.commitmentPath),
    preflight_gate: preflightGate,
    mutation_gate,
    operation: plan.existing ? 'update_existing_commitment' : 'create_commitment',
    commitment_id: plan.nextCommitment.id,
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
    `Stay-Alive commitment promotion (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `dry_run: ${report.dry_run ? 'yes' : 'no'}`,
    `commitment_hash: ${report.commitment_hash}`,
    `operation: ${report.operation}`,
    `commitment_id: ${report.commitment_id}`,
    `status: ${report.commitment_preview.status}`,
    `changed_files: ${report.changed_files.join(', ') || 'none'}`,
    'external_write: no',
    'botland_send: no'
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildCommitment(args);
  if (promotionAlreadyExists(plan.agentDir, args.commitmentHash)) {
    throw new Error(`Commitment update ${args.commitmentHash} has already been promoted`);
  }
  const report = {
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    commitment_hash: args.commitmentHash,
    commitment_update_path: path.relative(WORKSPACE, plan.commitmentPath),
    operation: plan.existing ? 'update_existing_commitment' : 'create_commitment',
    commitment_id: plan.nextCommitment.id,
    commitment_preview: plan.nextCommitment,
    changed_files: [],
    local_only: true,
    external_write: false
  };
  if (!args.dryRun) {
    const action = applyPromotion(args, plan);
    report.action_id = action.action_id;
    report.changed_files = action.result.changed_files;
  }
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
