#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE,
  actionsForProposal,
  collectProposalActions,
  findProposal,
  parseCommonArgs,
  proposalActionsDir,
  proposalStatus,
  stamp,
  writeJson
} from './proposal-lib.mjs';

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

try {
  const args = parseCommonArgs(process.argv.slice(2), { approvedBy: 'tool-supervision' });
  if (args.help || !args.proposalId || !args.proposalHash) {
    console.log('Usage: node scripts/stay-alive/approve-proposal.mjs --proposal-id <id> --proposal-hash <hash> [--agent badclaw] [--note text] [--json]');
    process.exit(args.help ? 0 : 1);
  }
  const proposal = findProposal(args);
  const actions = actionsForProposal(collectProposalActions(args), proposal);
  const status = proposalStatus(actions);
  if (status !== 'proposed') throw new Error(`Proposal is not approvable; current status=${status}`);
  const now = new Date();
  const action = {
    action_id: stamp('proposal_approve', now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: true,
    status: 'approved',
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    run_id: proposal.run_id,
    run_path: proposal.run_path,
    proposal_kind: proposal.kind,
    proposal_index: proposal.index,
    approved_by: args.approvedBy,
    note: args.note ?? null,
    preflight_gate: runPreflight(args),
    external_write: false,
    result: { ok: true, external_write: false }
  };
  const actionPath = path.join(proposalActionsDir(args.runtimeRoot, args.agent), `${action.action_id}.json`);
  writeJson(actionPath, action);
  const output = {
    action_id: action.action_id,
    status: action.status,
    action_path: path.relative(WORKSPACE, actionPath),
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    external_write: false
  };
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
