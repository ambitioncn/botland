import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const WORKSPACE = process.cwd();

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return readJson(file);
}

export function agentDir(runtimeRoot, agent) {
  return path.join(runtimeRoot, agent);
}

export function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse();
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function proposalKey(proposal) {
  return `${proposal.run_id}:${proposal.kind}:${proposal.index}`;
}

export function proposalHash(proposal) {
  return sha256({
    run_id: proposal.run_id,
    kind: proposal.kind,
    index: proposal.index,
    payload: proposal.payload
  });
}

export function proposalText(proposal) {
  const value = proposal.payload?.text ?? proposal.payload?.value ?? '';
  const text = typeof value === 'string' ? value : stableStringify(value);
  return String(text).replace(/\s+/g, ' ').trim();
}

export function proposalTarget(proposal) {
  return proposal.payload?.path ?? proposal.payload?.type ?? 'n/a';
}

export function proposalGroupKey(proposal) {
  return sha256({
    kind: proposal.kind,
    cycle: proposal.cycle ?? null,
    target: proposalTarget(proposal),
    text: proposalText(proposal)
  });
}

function runBotlandIdentityTrusted(run) {
  const summaries = [
    run?.social_read_summary?.botland_actor,
    run?.community_read_summary?.botland_actor,
    run?.botland_actor
  ].filter(Boolean);
  if (summaries.some((actor) => actor.identity_match === false)) return false;

  const observations = Array.isArray(run?.observations) ? run.observations : [];
  if (observations.some((item) => item?.topic === 'botland_identity' && item?.severity === 'error')) {
    return false;
  }
  return true;
}

export function collectRunProposals(args) {
  const runsDir = path.join(agentDir(args.runtimeRoot, args.agent), 'runs');
  const runProposals = listJsonFiles(runsDir).slice(0, args.limit ?? 200).flatMap((file) => {
    let run = null;
    try {
      run = readJson(file);
    } catch {
      return [];
    }
    const memory = Array.isArray(run.memory_updates) ? run.memory_updates : [];
    const relationships = Array.isArray(run.relationship_updates) ? run.relationship_updates : [];
    const commitments = Array.isArray(run.commitment_updates) ? run.commitment_updates : [];
    const desires = Array.isArray(run.desire_updates) ? run.desire_updates : [];
    const state = Array.isArray(run.state_updates) ? run.state_updates : [];
    const sourceIntegrity = {
      botland_identity_trusted: runBotlandIdentityTrusted(run)
    };
    return [
      ...memory.map((payload, index) => ({
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: run.created_at ?? null,
        cycle: run.cycle ?? null,
        kind: 'memory_update',
        index,
        payload,
        source_integrity: sourceIntegrity
      })),
      ...relationships.map((payload, index) => ({
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: run.created_at ?? null,
        cycle: run.cycle ?? null,
        kind: 'relationship_update',
        index,
        payload,
        source_integrity: sourceIntegrity
      })),
      ...commitments.map((payload, index) => ({
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: run.created_at ?? null,
        cycle: run.cycle ?? null,
        kind: 'commitment_update',
        index,
        payload,
        source_integrity: sourceIntegrity
      })),
      ...desires.map((payload, index) => ({
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: run.created_at ?? null,
        cycle: run.cycle ?? null,
        kind: 'desire_update',
        index,
        payload,
        source_integrity: sourceIntegrity
      })),
      ...state.map((payload, index) => ({
        run_id: run.run_id,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: run.created_at ?? null,
        cycle: run.cycle ?? null,
        kind: 'state_update',
        index,
        payload,
        source_integrity: sourceIntegrity
      }))
    ].map((proposal) => ({
      ...proposal,
      proposal_id: proposalKey(proposal),
      proposal_hash: proposalHash(proposal)
    }));
  });
  return [...runProposals, ...collectActionOutcomeProposals(args)];
}

export function collectActionOutcomeProposals(args) {
  const outcomesDir = path.join(agentDir(args.runtimeRoot, args.agent), 'action_outcomes');
  return listJsonFiles(outcomesDir).slice(0, args.limit ?? 200).flatMap((file) => {
    let outcome = null;
    try {
      outcome = readJson(file);
    } catch {
      return [];
    }
    const memory = Array.isArray(outcome.memory_updates) ? outcome.memory_updates : [];
    const relationships = Array.isArray(outcome.relationship_updates) ? outcome.relationship_updates : [];
    const commitments = Array.isArray(outcome.commitment_updates) ? outcome.commitment_updates : [];
    const desires = Array.isArray(outcome.desire_updates) ? outcome.desire_updates : [];
    return [
      ...memory.map((payload, index) => ({
        run_id: outcome.outcome_id ?? `action_outcome:${outcome.send_action_id}`,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: outcome.created_at ?? null,
        cycle: 'action_outcome',
        kind: 'memory_update',
        index,
        payload,
        proposal_source: {
          type: 'action_outcome',
          send_action_id: outcome.send_action_id ?? null,
          action_type: outcome.action_type ?? null,
          outcome_status: outcome.outcome_status ?? null
        }
      })),
      ...relationships.map((payload, index) => ({
        run_id: outcome.outcome_id ?? `action_outcome:${outcome.send_action_id}`,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: outcome.created_at ?? null,
        cycle: 'action_outcome',
        kind: 'relationship_update',
        index,
        payload,
        proposal_source: {
          type: 'action_outcome',
          send_action_id: outcome.send_action_id ?? null,
          action_type: outcome.action_type ?? null,
          outcome_status: outcome.outcome_status ?? null
        }
      })),
      ...commitments.map((payload, index) => ({
        run_id: outcome.outcome_id ?? `action_outcome:${outcome.send_action_id}`,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: outcome.created_at ?? null,
        cycle: 'action_outcome',
        kind: 'commitment_update',
        index,
        payload,
        proposal_source: {
          type: 'action_outcome',
          send_action_id: outcome.send_action_id ?? null,
          action_type: outcome.action_type ?? null,
          outcome_status: outcome.outcome_status ?? null
        }
      })),
      ...desires.map((payload, index) => ({
        run_id: outcome.outcome_id ?? `action_outcome:${outcome.send_action_id}`,
        run_path: path.relative(WORKSPACE, file),
        run_created_at: outcome.created_at ?? null,
        cycle: 'action_outcome',
        kind: 'desire_update',
        index,
        payload,
        proposal_source: {
          type: 'action_outcome',
          send_action_id: outcome.send_action_id ?? null,
          action_type: outcome.action_type ?? null,
          outcome_status: outcome.outcome_status ?? null
        }
      }))
    ].map((proposal) => ({
      ...proposal,
      proposal_id: proposalKey(proposal),
      proposal_hash: proposalHash(proposal)
    }));
  });
}

export function proposalActionsDir(runtimeRoot, agent) {
  return path.join(agentDir(runtimeRoot, agent), 'proposal_actions');
}

export function memoryUpdatesDir(runtimeRoot, agent) {
  return path.join(agentDir(runtimeRoot, agent), 'memory_updates');
}

export function relationshipUpdatesDir(runtimeRoot, agent) {
  return path.join(agentDir(runtimeRoot, agent), 'relationship_updates');
}

export function commitmentUpdatesDir(runtimeRoot, agent) {
  return path.join(agentDir(runtimeRoot, agent), 'commitment_updates');
}

export function desireUpdatesDir(runtimeRoot, agent) {
  return path.join(agentDir(runtimeRoot, agent), 'desire_updates');
}

export function collectProposalActions(args) {
  return listJsonFiles(proposalActionsDir(args.runtimeRoot, args.agent)).map((file) => ({
    ...readJson(file),
    action_path: path.relative(WORKSPACE, file)
  })).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

export function actionsForProposal(actions, proposal) {
  return actions.filter((action) => (
    action.proposal_id === proposal.proposal_id
    && action.proposal_hash === proposal.proposal_hash
  ));
}

export function proposalStatus(actions) {
  if (actions.some((action) => action.status === 'applied')) return 'applied';
  if (actions.some((action) => action.status === 'approved')) return 'approved';
  if (actions.some((action) => action.status === 'dismissed')) return 'dismissed';
  return 'proposed';
}

export function parseCommonArgs(argv, defaults = {}) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 200,
    format: 'text',
    ...defaults
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--proposal-id') args.proposalId = argv[++i];
    else if (arg === '--proposal-hash') args.proposalHash = argv[++i];
    else if (arg === '--approved-by') args.approvedBy = argv[++i];
    else if (arg === '--dismissed-by') args.dismissedBy = argv[++i];
    else if (arg === '--reason') args.reason = argv[++i];
    else if (arg === '--note') args.note = argv[++i];
    else if (arg === '--confirm-apply') args.confirmApply = argv[++i];
    else if (arg === '--compact') args.compact = true;
    else if (arg === '--include-superseded') args.includeSuperseded = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return args;
}

export function findProposal(args) {
  const proposals = collectRunProposals(args);
  const proposal = proposals.find((item) => (
    (!args.proposalId || item.proposal_id === args.proposalId)
    && (!args.proposalHash || item.proposal_hash === args.proposalHash)
  ));
  if (!proposal) throw new Error('Proposal not found in recent run artifacts');
  return proposal;
}

export function stamp(prefix, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${prefix}_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
