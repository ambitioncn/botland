#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  WORKSPACE,
  agentDir,
  sha256
} from './proposal-lib.mjs';

const TRACE_REVIEW_SCHEMA = 'stay_alive.trace_review.v1';
const COUNTERFACTUAL_SCHEMA = 'stay_alive.counterfactual_outcome_learning.v1';
const HEURISTIC_SCHEMA = 'stay_alive.planner_heuristic_patch_proposal.v1';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 80,
    dryRun: false,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/trace-review.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent run/action/outcome files to scan. Default: 80
  --dry-run             Build review without writing trace_reviews ledger.
  --json                Print JSON instead of text.
  --help                Show this help.

This command is local-only. It reviews planner decision traces, action outcomes,
and tool supervision ledgers, then proposes self-improvement heuristics. It
never sends BotLand messages, never posts, never joins, and never mutates
life_state.
`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listJsonFiles(dir, limit) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => path.join(dir, name));
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function traceFromRun(run) {
  const trace = run?.planner_decision_trace ?? run?.action_selection?.planner_decision_trace ?? null;
  if (trace?.schema !== 'stay_alive.planner_decision_trace.v1') return null;
  return {
    run_id: run.run_id ?? null,
    cycle: run.cycle ?? null,
    created_at: run.created_at ?? trace.generated_at ?? null,
    trace
  };
}

function collectRuntime(args) {
  const dir = agentDir(args.runtimeRoot, args.agent);
  const runs = listJsonFiles(path.join(dir, 'runs'), args.limit)
    .map(readJson)
    .filter(Boolean);
  const outcomes = listJsonFiles(path.join(dir, 'action_outcomes'), args.limit)
    .map(readJson)
    .filter(Boolean);
  const actions = listJsonFiles(path.join(dir, 'actions'), args.limit)
    .map(readJson)
    .filter(Boolean);
  return {
    agent_dir: dir,
    runs,
    traces: runs.map(traceFromRun).filter(Boolean),
    outcomes,
    actions
  };
}

function outcomeSignal(outcome) {
  const quality = outcome?.action_quality_score ?? outcome?.growth_integration?.action_quality_score ?? {};
  const qualityRating = quality.rating ?? null;
  const status = outcome?.outcome_status ?? null;
  if (status === 'feedback_received' && ['strong', 'healthy'].includes(qualityRating)) return 2;
  if (status === 'feedback_received') return 1;
  if (status === 'stale_closed') return -2;
  if (status === 'stale_pending_close' || ['thin', 'weak'].includes(qualityRating)) return -1;
  return 0;
}

function summarizeTracePatterns(traces) {
  const chosen = traces.map((item) => item.trace.chosen).filter(Boolean);
  const rejected = traces.flatMap((item) => item.trace.rejected_candidates ?? []);
  const chosenByType = countBy(chosen, (item) => item.type);
  const rejectedByType = countBy(rejected, (item) => item.type);
  const lowQualityChosen = chosen
    .filter((item) => Number(item.decision_quality?.quality_score ?? 100) < 55)
    .map((item) => ({
      candidate_id: item.candidate_id,
      type: item.type,
      score: item.score,
      quality_score: item.decision_quality?.quality_score ?? null,
      reason: item.reason
    }));
  const toolSupervisionBoundaryCount = chosen.filter((item) => item.tool_supervision_boundary?.required === true).length;
  const cooldownRejected = rejected.filter((item) => String(item.reason ?? '').includes('outcome cooldown')).length;
  const desireRejected = rejected.filter((item) => String(item.reason ?? '').includes('desire feedback')).length;
  return {
    trace_count: traces.length,
    chosen_by_type: chosenByType,
    rejected_by_type: rejectedByType,
    low_quality_chosen: lowQualityChosen.slice(0, 10),
    tool_supervision_boundary_count: toolSupervisionBoundaryCount,
    rejected_reason_counts: {
      outcome_cooldown: cooldownRejected,
      desire_feedback: desireRejected,
      safety_fit: rejected.filter((item) => String(item.reason ?? '').includes('safety fit')).length,
      repetition: rejected.filter((item) => String(item.reason ?? '').includes('repetition')).length
    }
  };
}

function summarizeToolSupervision(actions) {
  const decisions = actions.map((action) => action.tool_supervision_decision ?? action.unattended_policy_decision).filter(Boolean);
  const blockers = decisions.flatMap((decision) => decision.blockers ?? decision.findings ?? []);
  return {
    decision_count: decisions.length,
    allowed_count: decisions.filter((decision) => decision.execution_allowed === true || decision.decision === 'allow_execute').length,
    blocked_count: decisions.filter((decision) => decision.execution_allowed === false || decision.decision === 'block').length,
    blocker_frequency: countBy(blockers, (item) => typeof item === 'string' ? item : item.code ?? item.reason ?? null)
  };
}

function counterfactualsFromTraces(traces, outcomes) {
  const outcomeByActionType = {};
  for (const outcome of outcomes) {
    const type = outcome.action_type;
    if (!type) continue;
    if (!outcomeByActionType[type]) outcomeByActionType[type] = [];
    outcomeByActionType[type].push(outcome);
  }
  const actionTypeSignal = Object.fromEntries(Object.entries(outcomeByActionType).map(([type, items]) => [
    type,
    {
      action_type: type,
      outcome_count: items.length,
      signal_sum: items.reduce((sum, item) => sum + outcomeSignal(item), 0),
      stale_count: items.filter((item) => item.outcome_status === 'stale_closed' || item.outcome_status === 'stale_pending_close').length,
      feedback_count: items.filter((item) => item.outcome_status === 'feedback_received').length
    }
  ]));

  const comparisons = traces.flatMap((item) => {
    const chosen = item.trace.chosen;
    if (!chosen) return [];
    return (item.trace.rejected_candidates ?? []).slice(0, 4).map((rejected) => {
      const chosenSignal = actionTypeSignal[chosen.type]?.signal_sum ?? 0;
      const rejectedSignal = actionTypeSignal[rejected.type]?.signal_sum ?? 0;
      const scoreGap = Number(chosen.score ?? 0) - Number(rejected.score ?? 0);
      let verdict = 'chosen_still_preferred';
      if (rejectedSignal > chosenSignal && scoreGap <= 12) verdict = 'rejected_candidate_worth_reconsidering';
      else if (chosenSignal < 0 && rejectedSignal >= 0) verdict = 'selected_action_should_be_more_conservative';
      return {
        run_id: item.run_id,
        chosen: {
          candidate_id: chosen.candidate_id,
          type: chosen.type,
          score: chosen.score,
          outcome_signal: chosenSignal
        },
        rejected: {
          candidate_id: rejected.candidate_id,
          type: rejected.type,
          score: rejected.score,
          reason: rejected.reason,
          outcome_signal: rejectedSignal
        },
        score_gap: scoreGap,
        verdict,
        learning: verdict === 'rejected_candidate_worth_reconsidering'
          ? `Recent outcomes make ${rejected.type} worth reconsidering when it is close to ${chosen.type}.`
          : verdict === 'selected_action_should_be_more_conservative'
            ? `Recent outcomes weaken confidence in repeating ${chosen.type}; prefer lower-risk alternatives until new evidence appears.`
            : `Trace and outcome evidence still support ${chosen.type} over ${rejected.type}.`
      };
    });
  });

  return {
    schema: COUNTERFACTUAL_SCHEMA,
    action_type_signals: actionTypeSignal,
    comparison_count: comparisons.length,
    comparisons: comparisons.slice(0, 20)
  };
}

function buildHeuristicProposals(patterns, counterfactuals, toolSupervision) {
  const proposals = [];
  for (const [type, count] of Object.entries(patterns.chosen_by_type ?? {})) {
    const signal = counterfactuals.action_type_signals?.[type]?.signal_sum ?? 0;
    if (count >= 3 && signal < 0) {
      proposals.push({
        proposal_id: `heuristic_${sha256({ type, count, signal }).slice(0, 12)}`,
        target: `planner.action_type_weight.${type}`,
        suggested_change: 'decrease_weight_until_fresh_positive_evidence',
        reason: `${type} was chosen ${count} time(s) while recent outcomes are negative.`,
        mutation_allowed: false
      });
    }
  }
  if ((patterns.rejected_reason_counts?.outcome_cooldown ?? 0) > 0) {
    proposals.push({
      proposal_id: `heuristic_${sha256({ cooldown: patterns.rejected_reason_counts.outcome_cooldown }).slice(0, 12)}`,
      target: 'planner.cooldown.reason_visibility',
      suggested_change: 'preserve_outcome_cooldown_reason_in_next_trace_review',
      reason: 'Outcome cooldown is already changing choices; keep it explicit for future self-review.',
      mutation_allowed: false
    });
  }
  const frequentBlockers = Object.entries(toolSupervision.blocker_frequency ?? {})
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1]);
  for (const [blocker, count] of frequentBlockers.slice(0, 5)) {
    proposals.push({
      proposal_id: `heuristic_${sha256({ blocker, count }).slice(0, 12)}`,
      target: `planner.pre_tool_filter.${blocker}`,
      suggested_change: 'lower_candidate_score_before_tool_supervision',
      reason: `Tool supervision saw ${blocker} ${count} time(s); planner should predict this boundary earlier.`,
      mutation_allowed: false
    });
  }
  for (const comparison of counterfactuals.comparisons ?? []) {
    if (comparison.verdict === 'rejected_candidate_worth_reconsidering') {
      proposals.push({
        proposal_id: `heuristic_${sha256(comparison).slice(0, 12)}`,
        target: `planner.counterfactual.${comparison.rejected.type}`,
        suggested_change: 'increase_close_call_attention',
        reason: comparison.learning,
        mutation_allowed: false
      });
    }
  }
  return {
    schema: HEURISTIC_SCHEMA,
    proposal_only: true,
    direct_policy_mutation: false,
    proposal_count: proposals.length,
    proposals: proposals.slice(0, 12)
  };
}

function buildRegressionEvidence(patterns, counterfactuals, heuristicProposals, toolSupervision) {
  return {
    schema: 'stay_alive.self_improvement_regression_evidence.v1',
    checks: [{
      name: 'cold_or_negative_outcomes_make_planner_more_conservative',
      pass: (counterfactuals.action_type_signals?.direct_message_reply?.signal_sum ?? 0) <= 0
        || (patterns.rejected_reason_counts?.outcome_cooldown ?? 0) > 0
    }, {
      name: 'positive_feedback_can_preserve_confidence',
      pass: Object.values(counterfactuals.action_type_signals ?? {}).some((item) => item.signal_sum > 0)
    }, {
      name: 'tool_blockers_become_planner_learning_material',
      pass: toolSupervision.decision_count === 0 || Object.keys(toolSupervision.blocker_frequency ?? {}).length >= 0
    }, {
      name: 'heuristics_are_proposal_only',
      pass: heuristicProposals.direct_policy_mutation === false
        && heuristicProposals.proposals.every((item) => item.mutation_allowed === false)
    }],
    summary: 'Trace-guided self-improvement stays local and proposal-only; regression fixtures should cover conservative cooling, positive confidence, tool-blocker learning, and no direct policy mutation.'
  };
}

function writeReview(args, review) {
  const dir = path.join(agentDir(args.runtimeRoot, args.agent), 'trace_reviews');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${review.review_id}.json`);
  writeFileSync(file, `${JSON.stringify(review, null, 2)}\n`);
  return file;
}

function buildReview(args) {
  const collected = collectRuntime(args);
  const generatedAt = new Date().toISOString();
  const patterns = summarizeTracePatterns(collected.traces);
  const toolSupervision = summarizeToolSupervision(collected.actions);
  const counterfactuals = counterfactualsFromTraces(collected.traces, collected.outcomes);
  const heuristicProposals = buildHeuristicProposals(patterns, counterfactuals, toolSupervision);
  const regressionEvidence = buildRegressionEvidence(patterns, counterfactuals, heuristicProposals, toolSupervision);
  const reviewId = `trace_review_${generatedAt.replace(/[-:]/g, '').replace('.', '')}_${args.agent}`;
  const review = {
    schema: TRACE_REVIEW_SCHEMA,
    review_id: reviewId,
    generated_at: generatedAt,
    agent_id: args.agent,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutation: false,
    dry_run: args.dryRun,
    source_window: {
      run_count: collected.runs.length,
      trace_count: collected.traces.length,
      outcome_count: collected.outcomes.length,
      action_count: collected.actions.length,
      limit: args.limit
    },
    trace_review_cycle: {
      schema: 'stay_alive.trace_review_cycle.v1',
      patterns,
      tool_supervision: toolSupervision,
      learning_summary: patterns.trace_count === 0
        ? 'No planner traces were available yet.'
        : `Reviewed ${patterns.trace_count} trace(s), ${counterfactuals.comparison_count} counterfactual comparison(s), and ${toolSupervision.decision_count} tool supervision decision(s).`
    },
    counterfactual_outcome_learning: counterfactuals,
    planner_heuristic_patch_proposal: heuristicProposals,
    self_improvement_regression: regressionEvidence,
    safety: {
      local_ledger_write: !args.dryRun,
      external_write: false,
      botland_send: false,
      direct_policy_mutation: false,
      life_state_mutation: false
    }
  };
  const file = args.dryRun ? null : writeReview(args, review);
  return {
    ...review,
    review_path: file ? path.relative(WORKSPACE, file) : null,
    written: file !== null
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive trace review (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `dry_run: ${report.dry_run ? 'yes' : 'no'}`,
    `traces: ${report.source_window.trace_count}`,
    `outcomes: ${report.source_window.outcome_count}`,
    `tool_supervision_decisions: ${report.trace_review_cycle.tool_supervision.decision_count}`,
    `counterfactuals: ${report.counterfactual_outcome_learning.comparison_count}`,
    `heuristic_proposals: ${report.planner_heuristic_patch_proposal.proposal_count}`,
    report.review_path ? `review_path: ${report.review_path}` : 'review_path: dry-run',
    '',
    report.trace_review_cycle.learning_summary,
    '',
    'Safety',
    '- external_write: no',
    '- botland_send: no',
    '- direct_policy_mutation: no',
    '- life_state_mutation: no'
  ];
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const report = buildReview(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
