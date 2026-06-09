#!/usr/bin/env node

import process from 'node:process';
import {
  actionsForProposal,
  collectProposalActions,
  collectRunProposals,
  findProposal,
  parseCommonArgs,
  proposalGroupKey,
  proposalStatus,
  proposalTarget,
  proposalText
} from './proposal-lib.mjs';

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/proposal-packet.mjs --proposal-id <id> --proposal-hash <hash> [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent run artifacts to scan. Default: 200
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It opens one proposal review packet with duplicate
group context and safe next commands.
`);
}

function buildPacket(args) {
  const proposal = findProposal(args);
  const actions = collectProposalActions(args);
  const history = actionsForProposal(actions, proposal);
  const groupKey = proposalGroupKey(proposal);
  const group = collectRunProposals(args)
    .filter((item) => proposalGroupKey(item) === groupKey)
    .map((item) => {
      const itemHistory = actionsForProposal(actions, item);
      return {
        proposal_id: item.proposal_id,
        proposal_hash: item.proposal_hash,
        run_id: item.run_id,
        run_created_at: item.run_created_at,
        cycle: item.cycle,
        kind: item.kind,
        exact_status: proposalStatus(itemHistory)
      };
    });
  const applied = group.find((item) => item.exact_status === 'applied') ?? null;
  const approved = group.find((item) => item.exact_status === 'approved') ?? null;
  const dismissed = group.find((item) => item.exact_status === 'dismissed') ?? null;
  const proposed = group.find((item) => item.exact_status === 'proposed') ?? null;
  const closure = applied
    ? { status: 'applied_duplicate', proposal: applied }
    : dismissed
      ? { status: 'dismissed_duplicate', proposal: dismissed }
      : null;
  const latest = approved ?? proposed ?? applied ?? dismissed ?? group[0] ?? null;
  const exactStatus = proposalStatus(history);
  const closedByDifferentProposal = closure
    && closure.proposal
    && closure.proposal.proposal_hash !== proposal.proposal_hash;
  const status = exactStatus === 'proposed' && closedByDifferentProposal
    ? closure.status
    : exactStatus;
  const superseded = status === 'proposed' && latest && latest.proposal_hash !== proposal.proposal_hash;
  const members = group.map((item) => {
    const itemClosedByDifferentProposal = closure
      && closure.proposal
      && closure.proposal.proposal_hash !== item.proposal_hash
      && item.exact_status === 'proposed';
    return {
      ...item,
      status: itemClosedByDifferentProposal ? closure.status : item.exact_status,
      group_closed_by: itemClosedByDifferentProposal ? closure.proposal.proposal_id : null
    };
  });
  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    proposal: {
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      run_id: proposal.run_id,
      run_created_at: proposal.run_created_at,
      run_path: proposal.run_path,
      cycle: proposal.cycle,
      kind: proposal.kind,
      index: proposal.index,
      status,
      exact_status: exactStatus,
      apply_policy: proposal.payload?.apply_policy ?? null,
      target: proposalTarget(proposal),
      text: proposalText(proposal),
      payload: proposal.payload
    },
    duplicate_group: {
      group_key: groupKey,
      count: group.length,
      latest_proposal_id: latest?.proposal_id ?? null,
      latest_proposal_hash: latest?.proposal_hash ?? null,
      group_closed_by: closedByDifferentProposal ? closure.proposal.proposal_id : null,
      group_closed_status: closedByDifferentProposal ? closure.proposal.exact_status : null,
      superseded,
      members
    },
    action_history: history.map((action) => ({
      action_id: action.action_id,
      status: action.status,
      created_at: action.created_at,
      action_path: action.action_path,
      external_write: action.external_write
    })),
    recommended_next: superseded
      ? 'Review the latest proposal in this duplicate group instead of this superseded one.'
      : ['applied_duplicate', 'dismissed_duplicate'].includes(status)
        ? 'No action needed; this duplicate group was already processed locally.'
        : status === 'proposed'
        ? 'If the proposal is still useful, approve it locally before applying; otherwise dismiss it locally.'
        : status === 'approved'
          ? 'Apply only if this local memory/state update should become durable; otherwise dismiss it locally.'
          : 'No action needed for this proposal status.',
    commands: {
      approve: `node scripts/stay-alive/approve-proposal.mjs --agent ${args.agent} --proposal-id '${proposal.proposal_id}' --proposal-hash ${proposal.proposal_hash}`,
      apply: `node scripts/stay-alive/apply-proposal.mjs --agent ${args.agent} --proposal-id '${proposal.proposal_id}' --proposal-hash ${proposal.proposal_hash} --confirm-apply APPLY_PROPOSAL`,
      dismiss: `node scripts/stay-alive/dismiss-proposal.mjs --agent ${args.agent} --proposal-id '${proposal.proposal_id}' --proposal-hash ${proposal.proposal_hash}`
    },
    external_write: false,
    botland_send: false
  };
}

function formatText(packet) {
  const p = packet.proposal;
  const lines = [
    `Stay-Alive proposal packet (${packet.agent_id})`,
    `generated_at: ${packet.generated_at}`,
    '',
    `Proposal`,
    `- id: ${p.proposal_id}`,
    `- hash: ${p.proposal_hash}`,
    `- status: ${p.status}`,
    `- cycle: ${p.cycle}`,
    `- kind: ${p.kind}`,
    `- target: ${p.target}`,
    `- apply_policy: ${p.apply_policy ?? 'n/a'}`,
    `- text: ${p.text || 'n/a'}`,
    '',
    `Duplicate Group`,
    `- count: ${packet.duplicate_group.count}`,
    `- latest: ${packet.duplicate_group.latest_proposal_id ?? 'n/a'}`,
    `- closed_by: ${packet.duplicate_group.group_closed_by ?? 'n/a'}`,
    `- superseded: ${packet.duplicate_group.superseded ? 'yes' : 'no'}`,
    '',
    `Action History`
  ];
  if (packet.action_history.length === 0) lines.push('- none');
  for (const action of packet.action_history) {
    lines.push(`- ${action.status} ${action.action_id} at ${action.created_at}`);
  }
  lines.push('');
  lines.push(`Recommended Next`);
  lines.push(`- ${packet.recommended_next}`);
  lines.push('');
  lines.push(`Commands`);
  lines.push(`- approve: ${packet.commands.approve}`);
  lines.push(`- apply: ${packet.commands.apply}`);
  lines.push(`- dismiss: ${packet.commands.dismiss}`);
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help || !args.proposalId || !args.proposalHash) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const packet = buildPacket(args);
  if (args.format === 'json') console.log(JSON.stringify(packet, null, 2));
  else process.stdout.write(formatText(packet));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
