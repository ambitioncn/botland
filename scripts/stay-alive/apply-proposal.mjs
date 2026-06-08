#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE,
  actionsForProposal,
  agentDir,
  collectProposalActions,
  desireUpdatesDir,
  findProposal,
  commitmentUpdatesDir,
  memoryUpdatesDir,
  parseCommonArgs,
  proposalActionsDir,
  proposalStatus,
  relationshipUpdatesDir,
  readJson,
  stamp,
  writeJson
} from './proposal-lib.mjs';
import { assertMutationAllowed } from './life-state-mutation-protocol-lib.mjs';

function runPreflight(args) {
  const result = spawnSync(process.execPath, [
    'scripts/stay-alive/preflight.mjs',
    '--agent', args.agent,
    '--limit', '50',
    '--draft-limit', '200',
    '--history-limit', '3',
    '--no-checkpoint',
    '--json',
    ...(path.resolve(args.runtimeRoot) === path.resolve(path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'))
      ? []
      : ['--runtime-root', args.runtimeRoot])
  ], { cwd: WORKSPACE, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const stdout = result.stdout.trim();
  const parsed = stdout ? JSON.parse(stdout) : null;
  if (result.status !== 0 || parsed?.verdict?.pass !== true) {
    const findings = parsed?.verdict?.safety_findings?.join(', ') ?? result.stderr.trim() ?? 'unknown';
    throw new Error(`Preflight gate failed: ${findings}`);
  }
  return {
    ok: true,
    pass: parsed.verdict.pass,
    level: parsed.verdict.level,
    generated_at: parsed.generated_at,
    safety_findings: parsed.verdict.safety_findings ?? [],
    operator_decision: parsed.operator_decision
      ? {
          level: parsed.operator_decision.level,
          reason: parsed.operator_decision.reason
        }
      : null
  };
}

function setStatePath(lifeState, proposal) {
  const targetPath = proposal.payload?.path;
  if (typeof targetPath !== 'string') throw new Error('State update proposal must include payload.path');
  assertMutationAllowed({
    actor: 'governance_bookkeeping',
    path: targetPath,
    operation: 'proposal_state_update',
    evidence: {
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      run_id: proposal.run_id
    }
  });
  const parts = targetPath.split('.');
  let cursor = lifeState;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = proposal.payload.value;
}

try {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help || !args.proposalId || !args.proposalHash || args.confirmApply !== 'APPLY_PROPOSAL') {
    console.log('Usage: node scripts/stay-alive/apply-proposal.mjs --proposal-id <id> --proposal-hash <hash> --confirm-apply APPLY_PROPOSAL [--agent badclaw] [--json]');
    process.exit(args.help ? 0 : 1);
  }
  const proposal = findProposal(args);
  const actions = actionsForProposal(collectProposalActions(args), proposal);
  const status = proposalStatus(actions);
  if (status !== 'approved') throw new Error(`Proposal is not ready to apply; current status=${status}`);

  const now = new Date();
  const action = {
    action_id: stamp('proposal_apply', now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: true,
    status: 'applied',
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    run_id: proposal.run_id,
    run_path: proposal.run_path,
    proposal_kind: proposal.kind,
    proposal_index: proposal.index,
    preflight_gate: runPreflight(args),
    external_write: false,
    result: { ok: true, external_write: false, changed_files: [] }
  };

  if (proposal.kind === 'memory_update') {
    const memoryPath = path.join(memoryUpdatesDir(args.runtimeRoot, args.agent), `${proposal.proposal_hash}.json`);
    writeJson(memoryPath, {
      applied_at: now.toISOString(),
      agent_id: args.agent,
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      run_id: proposal.run_id,
      payload: proposal.payload,
      local_only: true,
      external_write: false
    });
    action.result.changed_files.push(path.relative(WORKSPACE, memoryPath));
  } else if (proposal.kind === 'relationship_update') {
    const relationshipPath = path.join(relationshipUpdatesDir(args.runtimeRoot, args.agent), `${proposal.proposal_hash}.json`);
    writeJson(relationshipPath, {
      applied_at: now.toISOString(),
      agent_id: args.agent,
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      run_id: proposal.run_id,
      payload: proposal.payload,
      local_only: true,
      external_write: false,
      promotion_target: proposal.payload?.promotion_target ?? null,
      promotion_allowed: proposal.payload?.promotion_allowed === true,
      note: 'Relationship candidate ledger only; applying this proposal does not mutate life_state.relationships.'
    });
    action.result.changed_files.push(path.relative(WORKSPACE, relationshipPath));
  } else if (proposal.kind === 'commitment_update') {
    const commitmentPath = path.join(commitmentUpdatesDir(args.runtimeRoot, args.agent), `${proposal.proposal_hash}.json`);
    writeJson(commitmentPath, {
      applied_at: now.toISOString(),
      agent_id: args.agent,
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      run_id: proposal.run_id,
      payload: proposal.payload,
      local_only: true,
      external_write: false,
      promotion_target: proposal.payload?.promotion_target ?? 'life_state.commitments',
      promotion_allowed: proposal.payload?.promotion_allowed === true,
      note: 'Commitment continuity ledger only; applying this proposal does not automatically perform the task or send BotLand messages.'
    });
    action.result.changed_files.push(path.relative(WORKSPACE, commitmentPath));
  } else if (proposal.kind === 'desire_update') {
    const desirePath = path.join(desireUpdatesDir(args.runtimeRoot, args.agent), `${proposal.proposal_hash}.json`);
    writeJson(desirePath, {
      applied_at: now.toISOString(),
      agent_id: args.agent,
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      run_id: proposal.run_id,
      payload: proposal.payload,
      local_only: true,
      external_write: false,
      promotion_target: proposal.payload?.promotion_target ?? 'life_state.current_desires',
      promotion_allowed: proposal.payload?.promotion_allowed === true,
      lifecycle_allowed: proposal.payload?.lifecycle_allowed === true,
      note: 'Desire/goal lifecycle ledger only; applying this proposal does not directly mutate life_state.current_desires.'
    });
    action.result.changed_files.push(path.relative(WORKSPACE, desirePath));
  } else if (proposal.kind === 'state_update') {
    const lifeStatePath = path.join(agentDir(args.runtimeRoot, args.agent), 'life_state.json');
    const lifeState = readJson(lifeStatePath);
    setStatePath(lifeState, proposal);
    lifeState.updated_at = now.toISOString();
    writeJson(lifeStatePath, lifeState);
    action.result.changed_files.push(path.relative(WORKSPACE, lifeStatePath));
  } else {
    throw new Error(`Unsupported proposal kind: ${proposal.kind}`);
  }

  const actionPath = path.join(proposalActionsDir(args.runtimeRoot, args.agent), `${action.action_id}.json`);
  writeJson(actionPath, action);
  action.result.changed_files.push(path.relative(WORKSPACE, actionPath));

  console.log(JSON.stringify({
    action_id: action.action_id,
    status: action.status,
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    changed_files: action.result.changed_files,
    external_write: false
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
