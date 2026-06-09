#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE,
  actionsForProposal,
  collectProposalActions,
  collectRunProposals,
  parseCommonArgs,
  proposalGroupKey,
  proposalStatus,
  proposalText
} from './proposal-lib.mjs';

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/review-proposals.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent run artifacts to scan. Default: 200
  --compact             Show only latest visible proposal per duplicate group.
  --include-superseded  Include older duplicate proposed items.
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It lists memory/relationship/state proposals from recent run
artifacts and their local approval/apply status.
`);
}

function buildReport(args) {
  const actions = collectProposalActions(args);
  const grouped = new Map();
  const proposals = collectRunProposals(args).map((proposal) => {
    const history = actionsForProposal(actions, proposal);
    const groupKey = proposalGroupKey(proposal);
    const item = {
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      group_key: groupKey,
      run_id: proposal.run_id,
      run_created_at: proposal.run_created_at,
      run_path: proposal.run_path,
      cycle: proposal.cycle,
      kind: proposal.kind,
      index: proposal.index,
      exact_status: proposalStatus(history),
      apply_policy: proposal.payload?.apply_policy ?? null,
      target_path: proposal.payload?.path ?? null,
      type: proposal.payload?.type ?? null,
      text_preview: proposalText(proposal).slice(0, 220),
      action_history: history.map((action) => ({
        action_id: action.action_id,
        status: action.status,
        created_at: action.created_at,
        action_path: action.action_path
      }))
    };
    const list = grouped.get(groupKey) ?? [];
    list.push(item);
    grouped.set(groupKey, list);
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
    const duplicate_count = grouped.get(proposal.group_key)?.length ?? 1;
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
      && duplicate_count > 1
    );
    return {
      ...proposal,
      status,
      duplicate_count,
      superseded,
      superseded_by: superseded ? latest.proposal_id : null,
      group_closed_by: closedByDifferentProposal ? closure.proposal.proposal_id : null,
      group_closed_status: closedByDifferentProposal ? closure.proposal.exact_status : null
    };
  });

  const visible = annotated.filter((proposal) => (
    ['proposed', 'approved'].includes(proposal.status)
    && (args.includeSuperseded || !proposal.superseded)
  ));
  const displayProposals = args.compact
    ? visible
    : annotated.filter((proposal) => args.includeSuperseded || !proposal.superseded);
  const groups = [...grouped.entries()].map(([group_key, items]) => ({
    group_key,
    count: items.length,
    latest_proposal_id: latestByGroup.get(group_key)?.proposal_id ?? null,
    cycle: items[0]?.cycle ?? null,
    kind: items[0]?.kind ?? null,
    target: items[0]?.target_path ?? items[0]?.type ?? null
  })).sort((a, b) => b.count - a.count);

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    proposal_count: annotated.length,
    group_count: grouped.size,
    duplicate_group_count: groups.filter((group) => group.count > 1).length,
    superseded_count: annotated.filter((proposal) => proposal.superseded).length,
    closed_duplicate_count: annotated.filter((proposal) => ['applied_duplicate', 'dismissed_duplicate'].includes(proposal.status)).length,
    visible_count: visible.length,
    approved_count: annotated.filter((proposal) => proposal.status === 'approved').length,
    applied_count: annotated.filter((proposal) => proposal.status === 'applied').length,
    dismissed_count: annotated.filter((proposal) => proposal.status === 'dismissed').length,
    proposals: displayProposals,
    groups
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive proposal review (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `proposals: ${report.proposal_count}`,
    `groups: ${report.group_count}`,
    `duplicate_groups: ${report.duplicate_group_count}`,
    `superseded: ${report.superseded_count}`,
    `visible: ${report.visible_count}`,
    `approved: ${report.approved_count}`,
    `applied: ${report.applied_count}`,
    `dismissed: ${report.dismissed_count}`,
    ''
  ];
  for (const proposal of report.proposals.slice(0, 30)) {
    lines.push(`- ${proposal.status} ${proposal.proposal_id}`);
    lines.push(`  hash: ${proposal.proposal_hash}`);
    lines.push(`  kind: ${proposal.kind} cycle=${proposal.cycle} target=${proposal.target_path ?? proposal.type ?? 'n/a'} duplicates=${proposal.duplicate_count}`);
    if (proposal.superseded_by) lines.push(`  superseded_by: ${proposal.superseded_by}`);
    if (proposal.group_closed_by) lines.push(`  group_closed_by: ${proposal.group_closed_by} (${proposal.group_closed_status})`);
    if (proposal.text_preview) lines.push(`  text: ${proposal.text_preview}`);
  }
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
