import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  WORKSPACE,
  actionsForProposal,
  collectProposalActions,
  collectRunProposals,
  proposalGroupKey,
  proposalStatus,
  proposalText
} from './proposal-lib.mjs';

export const SAFE_AUTO_STATE_PATHS = new Set([
  'reflection.last_integrated_at',
  'reflection.last_integration_summary',
  'reflection.last_full_reflection_at',
  'reflection.last_summary',
  'reflection.last_reflection_summary',
  'reflection.last_desire_review',
  'reflection.last_self_model_review'
]);

export const LOCAL_LEDGER_KINDS = new Set([
  'memory_update',
  'relationship_update',
  'commitment_update',
  'desire_update'
]);

export function runtimeRootArgs(runtimeRoot) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', runtimeRoot];
}

export function buildProposalSnapshot(args) {
  const actions = collectProposalActions(args);
  const grouped = new Map();
  const proposals = collectRunProposals(args).map((proposal) => {
    const history = actionsForProposal(actions, proposal);
    const groupKey = proposalGroupKey(proposal);
    const item = {
      ...proposal,
      group_key: groupKey,
      exact_status: proposalStatus(history),
      action_history: history.map((action) => ({
        action_id: action.action_id,
        status: action.status,
        created_at: action.created_at,
        action_path: action.action_path
      })),
      apply_policy: proposal.payload?.apply_policy ?? null,
      target_path: proposal.payload?.path ?? null,
      type: proposal.payload?.type ?? null,
      source_integrity: proposal.source_integrity ?? null,
      text_preview: proposalText(proposal).slice(0, 220)
    };
    const group = grouped.get(groupKey) ?? [];
    group.push(item);
    grouped.set(groupKey, group);
    return item;
  });

  const latestByGroup = new Map();
  const groupClosureByGroup = new Map();
  for (const [groupKey, items] of grouped.entries()) {
    const applied = items.find((proposal) => proposal.exact_status === 'applied') ?? null;
    const approved = items.find((proposal) => proposal.exact_status === 'approved') ?? null;
    const dismissed = items.find((proposal) => proposal.exact_status === 'dismissed') ?? null;
    const proposed = items.find((proposal) => proposal.exact_status === 'proposed') ?? null;
    const closure = applied
      ? { status: 'applied_duplicate', proposal: applied }
      : dismissed
        ? { status: 'dismissed_duplicate', proposal: dismissed }
        : null;
    groupClosureByGroup.set(groupKey, closure);
    latestByGroup.set(groupKey, approved ?? proposed ?? applied ?? dismissed ?? items[0] ?? null);
  }

  const annotated = proposals.map((proposal) => {
    const latest = latestByGroup.get(proposal.group_key);
    const duplicateCount = grouped.get(proposal.group_key)?.length ?? 1;
    const closure = groupClosureByGroup.get(proposal.group_key);
    const closedByDifferentProposal = closure
      && closure.proposal
      && closure.proposal.proposal_hash !== proposal.proposal_hash;
    const status = proposal.exact_status === 'proposed' && closedByDifferentProposal
      ? closure.status
      : proposal.exact_status;
    const superseded = (
      status === 'proposed'
      && latest
      && proposal.proposal_hash !== latest.proposal_hash
      && duplicateCount > 1
    );
    return {
      ...proposal,
      status,
      duplicate_count: duplicateCount,
      superseded,
      superseded_by: superseded ? latest.proposal_id : null,
      group_closed_by: closedByDifferentProposal ? closure.proposal.proposal_id : null,
      group_closed_status: closedByDifferentProposal ? closure.proposal.exact_status : null
    };
  });

  const groups = [...grouped.entries()].map(([groupKey, items]) => ({
    group_key: groupKey,
    count: items.length,
    latest_proposal_id: latestByGroup.get(groupKey)?.proposal_id ?? null,
    cycle: items[0]?.cycle ?? null,
    kind: items[0]?.kind ?? null,
    target: items[0]?.target_path ?? items[0]?.type ?? null
  })).sort((a, b) => b.count - a.count);

  return {
    actions,
    proposals: annotated,
    groups
  };
}

function proposalCommand(script, args, proposal, extra = []) {
  return [
    process.execPath,
    script,
    '--agent', args.agent,
    '--limit', String(args.limit),
    ...runtimeRootArgs(args.runtimeRoot),
    '--proposal-id', proposal.proposal_id,
    '--proposal-hash', proposal.proposal_hash,
    ...extra
  ].join(' ');
}

function classifyVisibleProposal(args, proposal) {
  if (proposal.source_integrity?.botland_identity_trusted === false) {
    if (proposal.status === 'approved') {
      return {
        decision: 'review',
        lane: 'untrusted_run_identity_approved',
        risk: 'high',
        reason: 'Proposal source run recorded BotLand identity mismatch; approved items must not auto-apply.',
        command: null
      };
    }
    return {
      decision: 'dismiss',
      lane: 'untrusted_run_identity',
      risk: 'high',
      reason: 'Proposal source run recorded BotLand identity mismatch; local governance should not preserve contaminated evidence.',
      command: proposalCommand('scripts/stay-alive/dismiss-proposal.mjs', args, proposal, ['--reason', JSON.stringify('source BotLand identity mismatch')])
    };
  }

  if (proposal.superseded) {
    return {
      decision: 'dismiss',
      lane: 'stale_duplicate',
      risk: 'low',
      reason: 'Older duplicate proposal is superseded by a newer visible proposal.',
      command: proposalCommand('scripts/stay-alive/dismiss-proposal.mjs', args, proposal, ['--reason', JSON.stringify('superseded by newer duplicate')])
    };
  }

  if (proposal.status === 'approved') {
    if (LOCAL_LEDGER_KINDS.has(proposal.kind)) {
      return {
        decision: 'apply',
        lane: `${proposal.kind}_ledger`,
        risk: 'low',
        reason: `${proposal.kind} is already approved; applying writes only local ledger state.`,
        command: proposalCommand('scripts/stay-alive/apply-proposal.mjs', args, proposal, ['--confirm-apply', 'APPLY_PROPOSAL'])
      };
    }
    if (proposal.kind === 'state_update' && SAFE_AUTO_STATE_PATHS.has(proposal.target_path)) {
      return {
        decision: 'apply',
        lane: 'safe_reflection_state',
        risk: 'medium',
        reason: 'Approved state proposal targets an allowlisted reflection path.',
        command: proposalCommand('scripts/stay-alive/apply-proposal.mjs', args, proposal, ['--confirm-apply', 'APPLY_PROPOSAL'])
      };
    }
    return {
      decision: 'review',
      lane: 'approved_manual_review',
      risk: 'medium',
      reason: 'Approved proposal is not in the auto-apply allowlist.',
      command: null
    };
  }

  if (proposal.status !== 'proposed') {
    return {
      decision: 'skip',
      lane: 'closed',
      risk: 'none',
      reason: `Proposal status is ${proposal.status}.`,
      command: null
    };
  }

  if (proposal.kind === 'memory_update') {
    return {
      decision: 'approve_apply',
      lane: 'memory_sync_candidate',
      risk: 'low',
      reason: 'Memory proposal applies only to local memory_update ledger; later backend sync remains a separate confirmed step.',
      command: proposalCommand('scripts/stay-alive/apply-proposal.mjs', args, proposal, ['--confirm-apply', 'APPLY_PROPOSAL'])
    };
  }

  if (['relationship_update', 'commitment_update', 'desire_update'].includes(proposal.kind)) {
    const subtype = proposal.payload?.candidate_type ?? proposal.payload?.lifecycle_action ?? proposal.payload?.type ?? 'candidate';
    const observationOnly = subtype === 'observation_only' || proposal.payload?.promotion_allowed === false;
    if (observationOnly) {
      return {
        decision: 'dismiss',
        lane: `${proposal.kind}_observation_only`,
        risk: 'low',
        reason: 'Observation-only candidate is useful as run evidence but should not become durable ledger state.',
        command: proposalCommand('scripts/stay-alive/dismiss-proposal.mjs', args, proposal, ['--reason', JSON.stringify('observation-only proposal')])
      };
    }
    return {
      decision: 'approve_apply',
      lane: `${proposal.kind}_ledger`,
      risk: 'low',
      reason: `${proposal.kind} applies only to local ledger; promotion/lifecycle mutation remains a separate explicit command.`,
      command: proposalCommand('scripts/stay-alive/apply-proposal.mjs', args, proposal, ['--confirm-apply', 'APPLY_PROPOSAL'])
    };
  }

  if (proposal.kind === 'state_update') {
    if (SAFE_AUTO_STATE_PATHS.has(proposal.target_path)) {
      return {
        decision: 'approve_apply',
        lane: 'safe_reflection_state',
        risk: 'medium',
        reason: 'State update targets an allowlisted reflection bookkeeping path.',
        command: proposalCommand('scripts/stay-alive/apply-proposal.mjs', args, proposal, ['--confirm-apply', 'APPLY_PROPOSAL'])
      };
    }
    if (['current_desires', 'life_theme', 'self_model.last_evolution_summary'].includes(proposal.target_path)) {
      return {
        decision: 'dismiss',
        lane: 'legacy_direct_state_update',
        risk: 'medium',
        reason: 'Direct identity/desire mutation is now superseded by proposal ledgers plus explicit promotion/lifecycle commands.',
        command: proposalCommand('scripts/stay-alive/dismiss-proposal.mjs', args, proposal, ['--reason', JSON.stringify('superseded by lifecycle governance')])
      };
    }
    return {
      decision: 'review',
      lane: 'state_manual_review',
      risk: 'medium',
      reason: `State path is not in governance allowlist: ${proposal.target_path ?? 'missing'}.`,
      command: null
    };
  }

  return {
    decision: 'review',
    lane: 'unknown_kind',
    risk: 'medium',
    reason: `Unknown proposal kind: ${proposal.kind}.`,
    command: null
  };
}

export function buildGovernancePlan(args) {
  const snapshot = buildProposalSnapshot(args);
  const items = snapshot.proposals.map((proposal) => {
    const classification = classifyVisibleProposal(args, proposal);
    return {
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      group_key: proposal.group_key,
      run_id: proposal.run_id,
      run_created_at: proposal.run_created_at,
      cycle: proposal.cycle,
      kind: proposal.kind,
      status: proposal.status,
      target_path: proposal.target_path,
      type: proposal.type,
      source_integrity: proposal.source_integrity,
      duplicate_count: proposal.duplicate_count,
      superseded: proposal.superseded,
      superseded_by: proposal.superseded_by,
      group_closed_by: proposal.group_closed_by,
      group_closed_status: proposal.group_closed_status,
      text_preview: proposal.text_preview,
      ...classification
    };
  });

  const visible = items.filter((item) => ['proposed', 'approved'].includes(item.status));
  const executable = visible.filter((item) => ['approve_apply', 'apply', 'dismiss'].includes(item.decision));
  const batchApply = executable.filter((item) => ['approve_apply', 'apply'].includes(item.decision));
  const batchDismiss = executable.filter((item) => item.decision === 'dismiss');
  const review = visible.filter((item) => item.decision === 'review');
  const closedDuplicate = items.filter((item) => ['applied_duplicate', 'dismissed_duplicate'].includes(item.status));

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    proposal_count: items.length,
    group_count: snapshot.groups.length,
    duplicate_group_count: snapshot.groups.filter((group) => group.count > 1).length,
    visible_count: visible.length,
    executable_count: executable.length,
    review_count: review.length,
    approved_count: items.filter((item) => item.status === 'approved').length,
    applied_count: items.filter((item) => item.status === 'applied').length,
    dismissed_count: items.filter((item) => item.status === 'dismissed').length,
    closed_duplicate_count: closedDuplicate.length,
    batches: {
      apply_local: batchApply.map((item) => item.proposal_id),
      dismiss_stale: batchDismiss.map((item) => item.proposal_id),
      manual_review: review.map((item) => item.proposal_id)
    },
    counts_by_decision: items.reduce((counts, item) => {
      counts[item.decision] = (counts[item.decision] ?? 0) + 1;
      return counts;
    }, {}),
    counts_by_lane: items.reduce((counts, item) => {
      counts[item.lane] = (counts[item.lane] ?? 0) + 1;
      return counts;
    }, {}),
    proposals: args.includeClosed ? items : visible,
    groups: snapshot.groups,
    next_commands: {
      dry_run_batch_apply: `node scripts/stay-alive/proposal-batch.mjs --agent ${args.agent} --limit ${args.limit} --mode apply-local --dry-run --json`,
      confirmed_batch_apply: `node scripts/stay-alive/proposal-batch.mjs --agent ${args.agent} --limit ${args.limit} --mode apply-local --confirm-batch APPLY_LOCAL_PROPOSALS --json`,
      dry_run_dismiss_stale: `node scripts/stay-alive/proposal-batch.mjs --agent ${args.agent} --limit ${args.limit} --mode dismiss-stale --dry-run --json`,
      confirmed_dismiss_stale: `node scripts/stay-alive/proposal-batch.mjs --agent ${args.agent} --limit ${args.limit} --mode dismiss-stale --confirm-batch DISMISS_STALE_PROPOSALS --json`
    },
    safety: {
      external_write: false,
      botland_send: false,
      promotion_or_lifecycle_mutation: false,
      note: 'Governance can approve/apply local ledgers and safe reflection state only; relationship/commitment/desire promotion commands remain separate.'
    }
  };
}

export function runJsonCommand(command, args, options = {}) {
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  const stdout = result.stdout.trim();
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }
  if (result.status !== 0 && options.throwOnError !== false) {
    throw new Error(result.stderr.trim() || stdout || `Command failed: ${command}`);
  }
  return {
    command,
    args,
    status: result.status ?? 0,
    ok: result.status === 0,
    stdout,
    stderr: result.stderr.trim(),
    parsed
  };
}
