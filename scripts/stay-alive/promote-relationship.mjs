#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { assertMutationAllowed } from './life-state-mutation-protocol-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    relationshipHash: null,
    confirmPromote: null,
    format: 'text',
    dryRun: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--relationship-hash') args.relationshipHash = argv[++i];
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
  if (!args.relationshipHash) throw new Error('--relationship-hash is required');
  if (!args.dryRun && args.confirmPromote !== 'PROMOTE_RELATIONSHIP') {
    throw new Error('Relationship promotion requires --confirm-promote PROMOTE_RELATIONSHIP');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/promote-relationship.mjs --relationship-hash <hash> [options]

Promote an applied local relationship candidate ledger into durable
life_state.relationships. This is local-only, runs preflight, and refuses
observation-only or low-evidence candidates.

Options:
  --agent <id>                           Agent id. Default: badclaw
  --runtime-root <dir>                   Runtime agents directory
  --relationship-hash <hash>             Applied relationship_updates hash
  --dry-run                              Preview only. Default
  --confirm-promote PROMOTE_RELATIONSHIP Write life_state + promotion ledger
  --json                                 Print JSON
  --help                                 Show this help
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

function normalizeSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function existingRelationship(lifeState, payload) {
  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  const citizenId = payload.target?.citizen_id ?? null;
  const displayName = payload.target?.display_name ?? null;
  const hint = payload.target?.hint ?? null;
  return relationships.find((relationship) => {
    const ids = [relationship.target_id, relationship.botland_citizen_id, relationship.citizen_id].filter(Boolean).map(String);
    const names = [relationship.name].filter(Boolean).map((name) => String(name).toLowerCase());
    return (citizenId && ids.includes(String(citizenId)))
      || (hint && ids.includes(String(hint)))
      || (displayName && names.includes(String(displayName).toLowerCase()));
  }) ?? null;
}

function validateCandidate(ledger) {
  const payload = ledger.payload ?? {};
  if (payload.type !== 'stay_alive_relationship_candidate') {
    throw new Error(`Unsupported relationship ledger type: ${payload.type ?? 'missing'}`);
  }
  if (payload.promotion_allowed !== true || payload.promotion_target !== 'life_state.relationships') {
    throw new Error(`Refusing non-promotable relationship candidate disposition=${payload.disposition ?? 'unknown'}`);
  }
  if (payload.disposition !== 'durable_note_candidate' && payload.disposition !== 'identity_binding_candidate') {
    throw new Error(`Refusing candidate disposition=${payload.disposition ?? 'unknown'}`);
  }
  if (!['medium', 'high'].includes(payload.confidence)) {
    throw new Error(`Refusing low-confidence relationship candidate confidence=${payload.confidence ?? 'missing'}`);
  }
  return payload;
}

function buildPromotion(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const relationshipPath = path.join(agentDir, 'relationship_updates', `${args.relationshipHash}.json`);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(relationshipPath)) throw new Error(`Relationship update not found: ${relationshipPath}`);
  const ledger = readJson(relationshipPath);
  const payload = validateCandidate(ledger);
  const lifeState = readJson(lifeStatePath);
  const existing = existingRelationship(lifeState, payload);
  const target = payload.target ?? {};
  const now = new Date();
  const citizenId = target.citizen_id ?? null;
  const displayName = target.display_name ?? null;
  const targetId = existing?.target_id
    ?? (citizenId ? `botland_${citizenId}` : normalizeSlug(displayName ?? target.hint ?? args.relationshipHash));
  const note = [
    `Promoted from relationship candidate ${args.relationshipHash}.`,
    payload.source_gap?.summary ?? null,
    payload.recommendation ?? null
  ].filter(Boolean).join(' ');
  const nextRelationship = existing
    ? {
        ...existing,
        botland_citizen_id: existing.botland_citizen_id ?? citizenId ?? undefined,
        citizen_id: existing.citizen_id ?? citizenId ?? undefined,
        last_interaction_at: existing.last_interaction_at ?? payload.applies_to?.generated_at ?? now.toISOString(),
        notes: Array.from(new Set([...(Array.isArray(existing.notes) ? existing.notes : []), note]))
      }
    : {
        target_id: targetId,
        name: displayName ?? target.hint ?? targetId,
        relationship: payload.disposition === 'durable_note_candidate' ? 'botland_friend' : 'observed_peer',
        botland_citizen_id: citizenId,
        last_interaction_at: payload.applies_to?.generated_at ?? now.toISOString(),
        notes: [note],
        evidence: {
          source: payload.applies_to?.source ?? null,
          source_gap_type: payload.source_gap?.type ?? null,
          confidence: payload.confidence,
          relationship_update_hash: args.relationshipHash
        }
      };
  return {
    agentDir,
    relationshipPath,
    lifeStatePath,
    ledger,
    payload,
    lifeState,
    existing,
    nextRelationship
  };
}

function applyPromotion(args, plan) {
  const now = new Date();
  const preflightGate = runPreflight(args);
  const mutation_gate = assertMutationAllowed({
    actor: 'lifecycle_evolution',
    path: 'relationships',
    operation: plan.existing ? 'update_existing_relationship' : 'create_relationship',
    evidence: {
      relationship_hash: args.relationshipHash,
      relationship_update_path: path.relative(WORKSPACE, plan.relationshipPath),
      preflight_pass: preflightGate.pass
    }
  });
  const relationships = Array.isArray(plan.lifeState.relationships) ? plan.lifeState.relationships : [];
  const nextRelationships = plan.existing
    ? relationships.map((relationship) => relationship.target_id === plan.existing.target_id ? plan.nextRelationship : relationship)
    : [...relationships, plan.nextRelationship];
  const lifeState = {
    ...plan.lifeState,
    relationships: nextRelationships,
    updated_at: now.toISOString()
  };
  writeJson(plan.lifeStatePath, lifeState);
  const actionId = stamp('relationship_promote', now);
  const actionPath = path.join(plan.agentDir, 'relationship_promotions', `${actionId}.json`);
  const action = {
    action_id: actionId,
    created_at: now.toISOString(),
    agent_id: args.agent,
    status: 'promoted',
    dry_run: false,
    relationship_hash: args.relationshipHash,
    relationship_update_path: path.relative(WORKSPACE, plan.relationshipPath),
    preflight_gate: preflightGate,
    mutation_gate,
    operation: plan.existing ? 'update_existing_relationship' : 'create_relationship',
    target_id: plan.nextRelationship.target_id,
    botland_citizen_id: plan.nextRelationship.botland_citizen_id ?? null,
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

function promotionAlreadyExists(agentDir, relationshipHash) {
  const dir = path.join(agentDir, 'relationship_promotions');
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .some((action) => action.relationship_hash === relationshipHash && action.status === 'promoted');
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive relationship promotion (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`dry_run: ${report.dry_run ? 'yes' : 'no'}`);
  lines.push(`relationship_hash: ${report.relationship_hash}`);
  lines.push(`operation: ${report.operation}`);
  lines.push(`target_id: ${report.target_id}`);
  lines.push(`botland_citizen_id: ${report.botland_citizen_id ?? 'n/a'}`);
  lines.push(`changed_files: ${report.changed_files.join(', ') || 'none'}`);
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPromotion(args);
  if (promotionAlreadyExists(plan.agentDir, args.relationshipHash)) {
    throw new Error(`Relationship update ${args.relationshipHash} has already been promoted`);
  }
  const report = {
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    relationship_hash: args.relationshipHash,
    relationship_update_path: path.relative(WORKSPACE, plan.relationshipPath),
    operation: plan.existing ? 'update_existing_relationship' : 'create_relationship',
    target_id: plan.nextRelationship.target_id,
    botland_citizen_id: plan.nextRelationship.botland_citizen_id ?? null,
    relationship_preview: plan.nextRelationship,
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
