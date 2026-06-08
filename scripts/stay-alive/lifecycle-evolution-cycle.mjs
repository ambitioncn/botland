#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { mutationProtocol } from './life-state-mutation-protocol-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    limit: 80,
    execute: false,
    confirmLifecycle: null,
    maxPromotions: 3,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--max-promotions') args.maxPromotions = Number.parseInt(argv[++i], 10);
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--confirm-lifecycle') args.confirmLifecycle = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.execute && args.confirmLifecycle !== 'RUN_LIFECYCLE_EVOLUTION') {
    throw new Error('Lifecycle evolution execute requires --confirm-lifecycle RUN_LIFECYCLE_EVOLUTION');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/lifecycle-evolution-cycle.mjs [options]

Autonomous local lifecycle cycle for life_state evolution. It promotes or
applies already-applied relationship/commitment/desire ledgers through the
life_state mutation protocol. It never sends BotLand messages and does not
require daily human confirmation.

Options:
  --agent <id>                         Agent id. Default: badclaw
  --runtime-root <dir>                 Runtime agents directory
  --limit <n>                          Update ledgers to inspect. Default: 80
  --max-promotions <n>                 Max successful local mutations. Default: 3
  --execute --confirm-lifecycle RUN_LIFECYCLE_EVOLUTION
                                       Apply local lifecycle mutations
  --json                               Print JSON
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function listJson(dir, limit) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => path.join(dir, name));
}

function readActions(agentDir, dirName) {
  return listJson(path.join(agentDir, dirName), 1000).map((file) => {
    try {
      return readJson(file);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function runNode(args, script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, '--agent', args.agent, ...(
    path.resolve(args.runtimeRoot) === path.resolve(DEFAULT_RUNTIME) ? [] : ['--runtime-root', args.runtimeRoot]
  ), ...scriptArgs, '--json'], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  let parsed = null;
  try {
    parsed = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    ok: result.status === 0,
    exit_code: result.status,
    stdout_json: parsed,
    stderr: result.stderr.trim()
  };
}

function alreadyHandled(actions, hashField, hash) {
  return actions.some((action) => action[hashField] === hash && ['promoted', 'applied'].includes(action.status));
}

function classifyUpdate(file) {
  const ledger = readJson(file);
  const payload = ledger.payload ?? {};
  const hash = path.basename(file, '.json');
  const policyText = [
    payload.recommendation,
    payload.note,
    payload.source_gap?.summary,
    ...(Array.isArray(payload.safety_notes) ? payload.safety_notes : [])
  ].filter(Boolean).join(' ').toLowerCase();
  const blocked = policyText.includes('do not auto-promote') || policyText.includes('do not autopromote');
  const base = { hash, file, blocked, block_reason: blocked ? 'candidate_text_disallows_auto_promotion' : null };
  if (payload.type === 'stay_alive_relationship_candidate') {
    return { ...base, kind: 'relationship', command: 'scripts/stay-alive/promote-relationship.mjs', hashArg: '--relationship-hash', confirmArgs: ['--confirm-promote', 'PROMOTE_RELATIONSHIP'] };
  }
  if (payload.type === 'stay_alive_commitment_candidate') {
    return { ...base, kind: 'commitment_promotion', command: 'scripts/stay-alive/promote-commitment.mjs', hashArg: '--commitment-hash', confirmArgs: ['--confirm-promote', 'PROMOTE_COMMITMENT'] };
  }
  if (payload.type === 'stay_alive_commitment_lifecycle_candidate') {
    return { ...base, kind: 'commitment_lifecycle', command: 'scripts/stay-alive/apply-commitment-lifecycle.mjs', hashArg: '--commitment-hash', confirmArgs: ['--confirm-apply', 'APPLY_COMMITMENT_LIFECYCLE'] };
  }
  if (payload.type === 'stay_alive_desire_candidate') {
    return { ...base, kind: 'desire_promotion', command: 'scripts/stay-alive/promote-desire.mjs', hashArg: '--desire-hash', confirmArgs: ['--confirm-promote', 'PROMOTE_DESIRE'] };
  }
  if (payload.type === 'stay_alive_desire_lifecycle_candidate') {
    return { ...base, kind: 'desire_lifecycle', command: 'scripts/stay-alive/apply-desire-lifecycle.mjs', hashArg: '--desire-hash', confirmArgs: ['--confirm-apply', 'APPLY_DESIRE_LIFECYCLE'] };
  }
  return null;
}

function collectCandidates(args, agentDir) {
  const relActions = readActions(agentDir, 'relationship_promotions');
  const commitmentPromotions = readActions(agentDir, 'commitment_promotions');
  const commitmentLifecycle = readActions(agentDir, 'commitment_lifecycle');
  const desirePromotions = readActions(agentDir, 'desire_promotions');
  const desireLifecycle = readActions(agentDir, 'desire_lifecycle');
  const files = [
    ...listJson(path.join(agentDir, 'relationship_updates'), args.limit),
    ...listJson(path.join(agentDir, 'commitment_updates'), args.limit),
    ...listJson(path.join(agentDir, 'desire_updates'), args.limit)
  ];
  return files.map(classifyUpdate).filter(Boolean).filter((candidate) => {
    if (candidate.kind === 'relationship') return !alreadyHandled(relActions, 'relationship_hash', candidate.hash);
    if (candidate.kind === 'commitment_promotion') return !alreadyHandled(commitmentPromotions, 'commitment_hash', candidate.hash);
    if (candidate.kind === 'commitment_lifecycle') return !alreadyHandled(commitmentLifecycle, 'commitment_hash', candidate.hash);
    if (candidate.kind === 'desire_promotion') return !alreadyHandled(desirePromotions, 'desire_hash', candidate.hash);
    if (candidate.kind === 'desire_lifecycle') return !alreadyHandled(desireLifecycle, 'desire_hash', candidate.hash);
    return false;
  });
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `lifecycle_evolution_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const candidates = collectCandidates(args, agentDir);
  const attempts = [];
  let applied = 0;
  for (const candidate of candidates) {
    if (applied >= args.maxPromotions) break;
    if (candidate.blocked) {
      attempts.push({
        kind: candidate.kind,
        hash: candidate.hash,
        update_path: path.relative(WORKSPACE, candidate.file),
        execute: args.execute,
        ok: false,
        skipped: true,
        block_reason: candidate.block_reason
      });
      continue;
    }
    const scriptArgs = [candidate.hashArg, candidate.hash, ...(args.execute ? candidate.confirmArgs : ['--dry-run'])];
    const result = runNode(args, candidate.command, scriptArgs);
    attempts.push({
      kind: candidate.kind,
      hash: candidate.hash,
      update_path: path.relative(WORKSPACE, candidate.file),
      command: candidate.command,
      execute: args.execute,
      ok: result.ok,
      exit_code: result.exit_code,
      stderr: result.stderr,
      report: result.stdout_json
    });
    if (result.ok && args.execute) applied += 1;
  }
  const ledger = {
    schema: 'stay_alive.lifecycle_evolution_cycle.v1',
    cycle_id: stamp(now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: !args.execute,
    autonomous: true,
    human_confirmation_required: false,
    mutation_protocol: mutationProtocol(),
    candidate_count: candidates.length,
    attempt_count: attempts.length,
    applied_count: applied,
    local_only: true,
    external_write: false,
    botland_send: false,
    attempts
  };
  const ledgerPath = path.join(agentDir, 'lifecycle_evolution', `${ledger.cycle_id}.json`);
  writeJson(ledgerPath, ledger);
  const report = {
    ...ledger,
    ledger_path: path.relative(WORKSPACE, ledgerPath)
  };
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else {
    console.log([
      `Stay-Alive lifecycle evolution cycle (${args.agent})`,
      `generated_at: ${ledger.created_at}`,
      `dry_run: ${ledger.dry_run ? 'yes' : 'no'}`,
      `human_confirmation_required: no`,
      `candidates: ${ledger.candidate_count}`,
      `attempts: ${ledger.attempt_count}`,
      `applied: ${ledger.applied_count}`,
      `external_write: no`,
      `ledger_path: ${report.ledger_path}`
    ].join('\n'));
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
