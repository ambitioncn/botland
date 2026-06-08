#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE,
  collectProposalActions,
  collectRunProposals,
  parseCommonArgs,
  proposalStatus
} from './proposal-lib.mjs';

function addIssue(issues, level, code, message, action = null) {
  issues.push({
    level,
    code,
    message,
    action_id: action?.action_id ?? null,
    proposal_id: action?.proposal_id ?? null
  });
}

function isIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function buildReport(args) {
  const actions = collectProposalActions(args);
  const proposalLookupLimit = Number.MAX_SAFE_INTEGER;
  const proposals = collectRunProposals({
    ...args,
    limit: proposalLookupLimit
  });
  const proposalHashes = new Map(proposals.map((proposal) => [proposal.proposal_hash, proposal]));
  const issues = [];
  const byProposal = new Map();

  for (const action of actions) {
    if (!action.action_id || typeof action.action_id !== 'string') {
      addIssue(issues, 'error', 'action_id_missing', 'Proposal action must include action_id', action);
    } else if (path.basename(action.action_path ?? '') !== `${action.action_id}.json`) {
      addIssue(issues, 'error', 'action_path_id_mismatch', 'Proposal action filename must match action_id', action);
    }
    if (action.agent_id !== args.agent) {
      addIssue(issues, 'error', 'agent_id_mismatch', `Proposal action agent_id must equal ${args.agent}`, action);
    }
    if (!isIso(action.created_at)) {
      addIssue(issues, 'error', 'created_at_invalid', 'Proposal action must include ISO created_at', action);
    }
    if (!['approved', 'applied', 'dismissed'].includes(action.status)) {
      addIssue(issues, 'error', 'status_invalid', 'Proposal action status must be approved/applied/dismissed', action);
    }
    if (action.external_write === true || action.result?.external_write !== false) {
      addIssue(issues, 'error', 'external_write_action', 'Proposal action must be local-only external_write=false', action);
    }
    if (!action.proposal_hash || !proposalHashes.has(action.proposal_hash)) {
      addIssue(issues, 'error', 'proposal_reference_missing', 'Proposal action references a proposal hash not found in recent runs', action);
    }
    const list = byProposal.get(action.proposal_hash) ?? [];
    list.push(action);
    byProposal.set(action.proposal_hash, list);
  }

  for (const [hash, history] of byProposal.entries()) {
    const approvals = history.filter((action) => action.status === 'approved');
    const applies = history.filter((action) => action.status === 'applied');
    const dismissals = history.filter((action) => action.status === 'dismissed');
    if (approvals.length > 1) addIssue(issues, 'error', 'multiple_approval_actions', 'Proposal has multiple approvals', approvals[1]);
    if (applies.length > 1) addIssue(issues, 'error', 'multiple_apply_actions', 'Proposal has multiple apply actions', applies[1]);
    if (dismissals.length > 1) addIssue(issues, 'error', 'multiple_dismiss_actions', 'Proposal has multiple dismiss actions', dismissals[1]);
    if (applies.length > 0 && approvals.length === 0) addIssue(issues, 'error', 'applied_without_approval', 'Proposal was applied without prior approval', applies[0]);
    if (applies.length > 0 && approvals.length > 0 && String(applies[0].created_at) < String(approvals[0].created_at)) {
      addIssue(issues, 'error', 'apply_before_approval', 'Proposal apply action predates approval', applies[0]);
    }
    if (applies.length > 0 && dismissals.length > 0) {
      addIssue(issues, 'error', 'applied_and_dismissed', 'Proposal cannot be both applied and dismissed', dismissals[0]);
    }
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  const statuses = proposals.map((proposal) => {
    const history = actions.filter((action) => action.proposal_hash === proposal.proposal_hash);
    return { ...proposal, status: proposalStatus(history), action_count: history.length };
  });

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    proposal_count: proposals.length,
    proposal_lookup_limit: 'all',
    action_count: actions.length,
    approved_count: statuses.filter((proposal) => proposal.status === 'approved').length,
    applied_count: statuses.filter((proposal) => proposal.status === 'applied').length,
    dismissed_count: statuses.filter((proposal) => proposal.status === 'dismissed').length,
    reference_error_count: issues.filter((issue) => issue.code === 'proposal_reference_missing').length,
    duplicate_action_error_count: issues.filter((issue) => ['multiple_approval_actions', 'multiple_apply_actions', 'multiple_dismiss_actions'].includes(issue.code)).length,
    external_write_action_count: issues.filter((issue) => issue.code === 'external_write_action').length,
    errors,
    warnings,
    proposal_sample_count: Math.min(50, statuses.length),
    proposals: statuses.slice(0, 50).map((proposal) => ({
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      kind: proposal.kind,
      run_id: proposal.run_id,
      status: proposal.status,
      action_count: proposal.action_count
    }))
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive proposal state verification (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `pass: ${report.pass ? 'yes' : 'no'}`,
    `level: ${report.level}`,
    `errors: ${report.error_count}`,
    `warnings: ${report.warning_count}`,
    `proposals: ${report.proposal_count}`,
    `actions: ${report.action_count}`,
    `approved: ${report.approved_count}`,
    `applied: ${report.applied_count}`,
    `dismissed: ${report.dismissed_count}`,
    `reference_errors: ${report.reference_error_count}`,
    `duplicate_action_errors: ${report.duplicate_action_error_count}`,
    `external_write_actions: ${report.external_write_action_count}`
  ];
  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) lines.push(`- ${issue.code}: ${issue.proposal_id ?? issue.action_id ?? 'n/a'} ${issue.message}`);
  }
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseCommonArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/stay-alive/proposal-state-verify.mjs [--agent badclaw] [--limit 200] [--json]');
    process.exit(0);
  }
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
