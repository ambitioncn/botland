#!/usr/bin/env node

import { createHash } from 'node:crypto';
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
    confirmPromote: null,
    dryRun: true,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--desire-hash') args.desireHash = argv[++i];
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
  if (!args.desireHash) throw new Error('--desire-hash is required');
  if (!args.dryRun && args.confirmPromote !== 'PROMOTE_DESIRE') {
    throw new Error('Desire promotion requires --confirm-promote PROMOTE_DESIRE');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/promote-desire.mjs --desire-hash <hash> [options]

Promote an applied local desire candidate ledger into durable
life_state.current_desires. This is local-only, runs preflight, and never sends
BotLand messages.
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
  if (payload.type !== 'stay_alive_desire_candidate') {
    throw new Error(`Unsupported desire ledger type: ${payload.type ?? 'missing'}`);
  }
  if (payload.promotion_allowed !== true || payload.promotion_target !== 'life_state.current_desires') {
    throw new Error('Refusing non-promotable desire candidate');
  }
  const status = payload.desired_status ?? 'active';
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`Unsupported desire status: ${status}`);
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    throw new Error('Desire candidate must include text');
  }
  if (!isIsoDateOrNull(payload.expires_at ?? payload.expiry ?? null)) {
    throw new Error('Desire candidate expires_at must be null or ISO time');
  }
  return payload;
}

function existingDesire(lifeState, payload) {
  const desires = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const evidenceHash = payload.evidence_hash ?? payload.evidence?.evidence_hash ?? null;
  const text = String(payload.text ?? '').trim().toLowerCase();
  return desires.find((desire) => (
    (evidenceHash && desire.evidence_hash === evidenceHash)
    || (text && String(desire.text ?? '').trim().toLowerCase() === text)
  )) ?? null;
}

function buildDesire(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const desirePath = path.join(agentDir, 'desire_updates', `${args.desireHash}.json`);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(desirePath)) throw new Error(`Desire update not found: ${desirePath}`);
  const ledger = readJson(desirePath);
  const payload = validateCandidate(ledger);
  const lifeState = readJson(lifeStatePath);
  const existing = existingDesire(lifeState, payload);
  const now = new Date();
  const evidenceHash = payload.evidence_hash ?? payload.evidence?.evidence_hash ?? sha256({
    text: payload.text,
    source: payload.source ?? null
  });
  const id = existing?.id ?? `desire_${args.agent}_${normalizeSlug(evidenceHash).slice(0, 16)}`;
  const nextDesire = {
    ...(existing ?? {}),
    id,
    text: payload.text.trim(),
    horizon: payload.horizon ?? existing?.horizon ?? 'medium',
    priority: payload.priority ?? existing?.priority ?? 'medium',
    status: payload.desired_status ?? existing?.status ?? 'active',
    related_relationships: payload.related_relationships ?? existing?.related_relationships ?? [],
    related_commitments: payload.related_commitments ?? existing?.related_commitments ?? [],
    success_signal: payload.success_signal ?? existing?.success_signal ?? null,
    expires_at: payload.expires_at ?? payload.expiry ?? existing?.expires_at ?? null,
    source: payload.source ?? existing?.source ?? null,
    last_reviewed_at: payload.last_reviewed_at ?? existing?.last_reviewed_at ?? null,
    evidence_hash: evidenceHash,
    created_at: existing?.created_at ?? ledger.applied_at ?? now.toISOString(),
    updated_at: now.toISOString(),
    evidence: {
      ...(existing?.evidence ?? {}),
      ...(payload.evidence ?? {}),
      desire_update_hash: args.desireHash,
      proposal_hash: ledger.proposal_hash ?? args.desireHash
    }
  };
  return { agentDir, desirePath, lifeStatePath, ledger, payload, lifeState, existing, nextDesire };
}

function promotionAlreadyExists(agentDir, desireHash) {
  const dir = path.join(agentDir, 'desire_promotions');
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .some((action) => action.desire_hash === desireHash && action.status === 'promoted');
}

function applyPromotion(args, plan) {
  const now = new Date();
  const preflightGate = runPreflight(args);
  const mutation_gate = assertMutationAllowed({
    actor: 'lifecycle_evolution',
    path: 'current_desires',
    operation: plan.existing ? 'update_existing_desire' : 'create_desire',
    evidence: {
      desire_hash: args.desireHash,
      desire_update_path: path.relative(WORKSPACE, plan.desirePath),
      preflight_pass: preflightGate.pass
    }
  });
  const desires = Array.isArray(plan.lifeState.current_desires) ? plan.lifeState.current_desires : [];
  const nextDesires = plan.existing
    ? desires.map((desire) => desire.id === plan.existing.id ? plan.nextDesire : desire)
    : [...desires, plan.nextDesire];
  writeJson(plan.lifeStatePath, {
    ...plan.lifeState,
    current_desires: nextDesires.slice(-8),
    updated_at: now.toISOString()
  });
  const actionId = stamp('desire_promote', now);
  const actionPath = path.join(plan.agentDir, 'desire_promotions', `${actionId}.json`);
  const action = {
    action_id: actionId,
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: 'promoted',
    dry_run: false,
    desire_hash: args.desireHash,
    desire_update_path: path.relative(WORKSPACE, plan.desirePath),
    preflight_gate: preflightGate,
    mutation_gate,
    operation: plan.existing ? 'update_existing_desire' : 'create_desire',
    desire_id: plan.nextDesire.id,
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
    `Stay-Alive desire promotion (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `dry_run: ${report.dry_run ? 'yes' : 'no'}`,
    `desire_hash: ${report.desire_hash}`,
    `operation: ${report.operation}`,
    `desire_id: ${report.desire_id}`,
    `status: ${report.desire_preview.status}`,
    `changed_files: ${report.changed_files.join(', ') || 'none'}`,
    'external_write: no',
    'botland_send: no'
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildDesire(args);
  if (promotionAlreadyExists(plan.agentDir, args.desireHash)) {
    throw new Error(`Desire update ${args.desireHash} has already been promoted`);
  }
  const report = {
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    desire_hash: args.desireHash,
    desire_update_path: path.relative(WORKSPACE, plan.desirePath),
    operation: plan.existing ? 'update_existing_desire' : 'create_desire',
    desire_id: plan.nextDesire.id,
    desire_preview: plan.nextDesire,
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
