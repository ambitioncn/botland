#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const CYCLES = ['light', 'social', 'community', 'reflect', 'integrate', 'agency'];
const REQUIRED_MATRIX = [
  'syntax',
  'current-runtime-readonly',
  'local-no-botland',
  'temp-runtime',
  'tool-supervised-write-dry-run',
  'artifact-corruption',
  'backend-fixtures',
  'botland-surface-fixtures',
  'runtime-hygiene',
  'onboarding',
  'badclaw-live-readonly'
];

const BOTLAND_STUB_AGENT_ARG_NORMALIZER = `agent="\${BOTLAND_AGENT:-}"
if [ "$1" = "--agent" ]; then
  agent="$2"
  shift 2
fi
`;

function listMjsScripts(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMjsScripts(file);
    if (entry.isFile() && entry.name.endsWith('.mjs')) return [path.relative(WORKSPACE, file)];
    return [];
  }).sort();
}

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    tempRoot: null,
    keepTemp: false,
    includeLiveReadOnly: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--temp-root') args.tempRoot = path.resolve(argv[++i]);
    else if (arg === '--keep-temp') args.keepTemp = true;
    else if (arg === '--include-live-readonly') args.includeLiveReadOnly = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.tempRoot) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
    args.tempRoot = path.join(WORKSPACE, 'tmp', 'stay-alive-regression', stamp);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/regression-suite.mjs [options]

Options:
  --agent <id>              Agent id. Default: badclaw
  --runtime-root <dir>      Runtime agents directory.
  --temp-root <dir>         Temporary runtime root for no-Botland cycle tests.
  --keep-temp               Keep temporary runtime after the suite.
  --include-live-readonly   Also run live read-only preflight without checkpoint.
  --json                    Print JSON instead of text.
  --help                    Show this help.

The default suite is local-only: syntax checks, current-runtime read-only
verifiers, no-Botland temp cycle runs, and compaction dry-run. It never sends
BotLand messages.
`);
}

function runStep(name, command, options = {}) {
  const started = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: WORKSPACE,
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 120000
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  const ok = result.status === 0;
  return {
    name,
    matrix: options.matrix ?? matrixForStepName(name),
    command: command.join(' '),
    ok,
    status: result.status,
    duration_ms: Date.now() - started,
    stdout_tail: stdout.slice(-2000),
    stderr_tail: stderr.slice(-2000),
    parsed_json: options.parseJson && stdout
      ? safeParseJson(stdout)
      : null
  };
}

function matrixForStepName(name) {
  if (name.startsWith('node --check')) return 'syntax';
  if (name.includes('live read-only')) return 'badclaw-live-readonly';
  if (name.includes('current runtime') || name.includes('compaction dry-run') || name.includes('hygiene dry-run') || name.includes('trace review dry-run') || name.includes('planner patch dry-run') || name.includes('self-discovery growth dry-run') || name.includes('growth continuity dry-run') || name.includes('durable becoming dry-run') || name.includes('operator dashboard') || name.includes('multi-agent readiness') || name.includes('feedback calibration') || name.includes('shadow trends') || name.includes('self-model evolution') || name.includes('operator review server') || name.includes('agency core') || name.includes('agency journal dry-run')) return 'current-runtime-readonly';
  if (name.includes('no-botland')) return 'local-no-botland';
  if (name.includes('external action policy') || name.includes('apply draft dry-run')) return 'tool-supervised-write-dry-run';
  if (name.includes('corruption')) return 'artifact-corruption';
  if (name.includes('memory-pro')) return 'backend-fixtures';
  if (name.includes('BotLand') && name.includes('surface fixture')) return 'botland-surface-fixtures';
  if (name.includes('runtime hygiene archive') || name.includes('archive restore drill')) return 'runtime-hygiene';
  if (name.includes('onboarding') || name.includes('migration')) return 'onboarding';
  if (name.startsWith('temp ')) return 'temp-runtime';
  return 'misc';
}

function buildMatrixReport(steps, includeLiveReadOnly) {
  const summary = {};
  for (const key of REQUIRED_MATRIX) {
    const relevant = steps.filter((step) => step.matrix === key);
    summary[key] = {
      required: key !== 'badclaw-live-readonly' || includeLiveReadOnly,
      present: relevant.length > 0,
      pass: relevant.length > 0 && relevant.every((step) => step.ok),
      step_count: relevant.length,
      failed_count: relevant.filter((step) => !step.ok).length
    };
  }
  summary['badclaw-live-readonly'].mode = includeLiveReadOnly ? 'enabled' : 'skipped_by_default';
  return summary;
}

function expectFailureStep(step, predicate, failureMessage) {
  if (step.status !== 0 && predicate(step.parsed_json ?? {}, step)) {
    return {
      ...step,
      ok: true,
      expected_failure: true
    };
  }
  return {
    ...step,
    ok: false,
    expected_failure: true,
    stderr_tail: `${step.stderr_tail}\n${failureMessage}`.trim()
  };
}

function buildFeedbackFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'feedback-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'actions'), { recursive: true });
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
elif [ "$1" = "inbox" ]; then
  printf '{"messages":[{"id":"m_self","created_at":"2026-05-31T09:00:02.000Z","sender_id":"agent_self","text":"sent"},{"id":"m_peer","created_at":"2026-05-31T09:03:00.000Z","sender_id":"agent_peer","sender_name":"小潮","text":"收到，这个很有帮助，我们继续按这个方向走。"}]}\\n'
else
  printf '{"ok":true}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    agent_id: args.agent,
    relationships: [],
    commitments: [{
      id: 'commitment_feedback_1',
      text: 'Follow up with agent_peer about the direction.',
      status: 'open',
      peer: { citizen_id: 'agent_peer' }
    }],
    current_desires: [{
      id: 'desire_feedback_1',
      text: 'Build a real relationship through useful feedback.',
      status: 'active',
      horizon: 'medium'
    }],
    write_policy: { writes_enabled: true }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'actions', 'draft_apply_fixture.json'), `${JSON.stringify({
    action_id: 'draft_apply_fixture',
    created_at: '2026-05-31T09:00:00.000Z',
    agent_id: args.agent,
    dry_run: false,
    target: {
      citizen_id: 'agent_peer',
      related_commitment_ids: ['commitment_feedback_1'],
      related_desire_ids: ['desire_feedback_1']
    },
    command: 'botland send',
    result: { ok: true, stdout_json: { message_id: 'msg_fixture' } }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'actions', 'send_inspect_fixture.json'), `${JSON.stringify({
    action_id: 'send_inspect_fixture',
    created_at: '2026-05-31T09:01:00.000Z',
    agent_id: args.agent,
    status: 'successful_send_inspected',
    inspected_action_id: 'draft_apply_fixture'
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateFeedbackOutcomeStep(step) {
  const outcome = step.parsed_json?.outcomes?.[0] ?? null;
  const counts = outcome?.proposal_counts ?? {};
  const interpretation = outcome?.observation?.feedback_interpretation ?? {};
  const valid = step.ok
    && outcome?.outcome_status === 'feedback_received'
    && interpretation.source === 'action_outcome_interpreter_v3'
    && interpretation.has_text_feedback === true
    && outcome?.observation?.context_window?.schema === 'stay_alive.feedback_context_window.v3'
    && outcome?.action_quality_score?.schema === 'stay_alive.action_quality_score.v1'
    && outcome?.action_quality_score?.scorer === 'action_quality_scoring_v1'
    && Array.isArray(outcome?.action_quality_score?.improvement_hints)
    && ['strong', 'healthy'].includes(outcome?.action_quality_score?.rating)
    && outcome?.growth_integration?.schema === 'stay_alive.growth_integration.v2'
    && outcome?.growth_integration?.relationship_learning_v1?.schema === 'stay_alive.relationship_learning.v1'
    && outcome?.growth_integration?.relationship_learning_v1?.confidence === 'medium'
    && outcome?.growth_integration?.desire_evolution_v1?.schema === 'stay_alive.desire_evolution.v1'
    && outcome?.growth_integration?.desire_evolution_v1?.suggested_change === 'strengthen'
    && outcome?.growth_integration?.desire_evolution_v1?.primary_desire_id === 'desire_feedback_1'
    && outcome?.growth_integration?.self_model_learning_v1?.schema === 'stay_alive.self_model_learning.v1'
    && outcome?.growth_integration?.self_model_learning_v1?.expression_signal === 'expression_received_text_feedback'
    && outcome?.growth_integration?.self_model_learning_v1?.self_model_patch_candidate?.direct_life_state_mutation === false
    && outcome?.growth_integration?.action_quality_scoring_v1?.rating === outcome?.action_quality_score?.rating
    && outcome?.growth_integration?.integration_status === 'feedback_integrated_as_proposals'
    && outcome?.relationship_updates?.[0]?.evidence?.relationship_learning?.schema === 'stay_alive.relationship_learning.v1'
    && outcome?.desire_updates?.[0]?.evidence?.desire_evolution?.schema === 'stay_alive.desire_evolution.v1'
    && outcome?.desire_updates?.[0]?.next_status === 'active'
    && outcome?.desire_updates?.[0]?.priority === 'high'
    && counts.memory_updates === 1
    && counts.relationship_updates === 1
    && counts.commitment_updates === 1
    && counts.desire_updates === 1;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nFeedback fixture did not produce mature feedback proposals.`.trim()
  };
}

function buildOutcomePlanningFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'outcome-planning-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'action_outcomes'), { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-02T13:00:00.000Z',
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw' },
    self_model: { name: 'BadClaw' },
    relationships: [],
    current_desires: [{
      id: 'desire_feedback_1',
      text: 'Build a real relationship through useful feedback.',
      status: 'active',
      horizon: 'medium'
    }],
    write_policy: { writes_enabled: true }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'action_outcomes', 'action_outcome_stale_direct.json'), `${JSON.stringify({
    schema_version: 1,
    outcome_id: 'action_outcome_stale_direct',
    created_at: '2026-06-02T12:55:00.000Z',
    agent_id: args.agent,
    action_type: 'direct_message_reply',
    outcome_status: 'stale_closed',
    observation: {
      feedback_count: 0,
      feedback_interpretation: {
        signal_strength: 'none',
        has_text_feedback: false,
        recommended_next: 'wait for a fresh direct signal before another DM'
      }
    },
    action_quality_score: {
      schema: 'stay_alive.action_quality_score.v1',
      scorer: 'action_quality_scoring_v1',
      overall: 42,
      rating: 'thin',
      axes: {
        context_grounding: 0.5,
        self_motivation: 0.5,
        relationship_respect: 0.4,
        growth_value: 0.3
      },
      improvement_hints: ['Wait for feedback before repeating the same direct action.']
    },
    growth_integration: {
      schema: 'stay_alive.growth_integration.v2',
      relationship_learning_v1: {
        schema: 'stay_alive.relationship_learning.v1',
        confidence: 'low',
        feedback_signal: 'silence',
        summary: 'Direct message went stale; use shorter context-first expression next time.'
      },
      desire_evolution_v1: {
        schema: 'stay_alive.desire_evolution.v1',
        primary_desire_id: 'desire_feedback_1',
        suggested_change: 'pause_or_redirect',
        reason: 'Closed silence should pause direct repetition.'
      },
      recommended_next: 'pause direct repetition until new context appears'
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'action_outcomes', 'action_outcome_positive_public.json'), `${JSON.stringify({
    schema_version: 1,
    outcome_id: 'action_outcome_positive_public',
    created_at: '2026-06-02T12:58:00.000Z',
    agent_id: args.agent,
    action_type: 'public_moment',
    outcome_status: 'feedback_received',
    observation: {
      feedback_count: 1,
      feedback_interpretation: {
        signal_strength: 'medium',
        has_text_feedback: true,
        recommended_next: 'continue public expression when grounded in a real observation'
      }
    },
    action_quality_score: {
      schema: 'stay_alive.action_quality_score.v1',
      scorer: 'action_quality_scoring_v1',
      overall: 78,
      rating: 'healthy',
      axes: {
        context_grounding: 0.8,
        self_motivation: 0.7,
        relationship_respect: 0.8,
        growth_value: 0.8
      },
      improvement_hints: []
    },
    growth_integration: {
      schema: 'stay_alive.growth_integration.v2',
      relationship_learning_v1: {
        schema: 'stay_alive.relationship_learning.v1',
        confidence: 'medium',
        feedback_signal: 'text_feedback',
        summary: 'Public expression with specific context earned feedback.'
      },
      desire_evolution_v1: {
        schema: 'stay_alive.desire_evolution.v1',
        primary_desire_id: 'desire_feedback_1',
        suggested_change: 'strengthen',
        reason: 'Text feedback supports this desire on public surface.'
      },
      recommended_next: 'prefer specific, grounded public expression'
    }
  }, null, 2)}\n`);
  return { runtimeRoot };
}

function validateOutcomePlanningStep(step) {
  const context = step.parsed_json?.outcome_planning_context ?? null;
  const candidates = step.parsed_json?.action_candidates ?? [];
  const socialCandidate = candidates.find((candidate) => candidate.type === 'social_read_review');
  const selection = step.parsed_json?.action_selection ?? {};
  const trace = step.parsed_json?.planner_decision_trace ?? selection.planner_decision_trace ?? null;
  const traceSocialCandidate = trace?.candidates?.find((candidate) => candidate.candidate_id === socialCandidate?.candidate_id);
  const valid = step.ok
    && context?.schema === 'stay_alive.outcome_planning_context.v1'
    && context.outcome_count === 2
    && context.outcome_cooldowns?.direct_message_reply < 0
    && context.action_type_adjustments?.public_moment > 0
    && context.desire_feedback?.desire_feedback_1?.suggested_planner_effect === 'decrease_related_action_weight'
    && context.self_model_learning?.schema === 'stay_alive.self_model_learning_context.v1'
    && socialCandidate?.evidence?.outcome_planning_context?.expression_policy?.style === 'continue_specific_and_warm'
    && trace?.schema === 'stay_alive.planner_decision_trace.v1'
    && trace.candidate_count === candidates.length
    && trace.chosen?.candidate_id === selection.selected_candidate_id
    && Array.isArray(trace.rejected_candidates)
    && trace.rejected_candidates.length >= 1
    && traceSocialCandidate?.outcome_influence?.expression_policy?.style === 'continue_specific_and_warm'
    && traceSocialCandidate?.tool_supervision_boundary?.required === false;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nOutcome-informed planner fixture did not expose cooldown, expression policy, desire feedback, and planner decision trace evidence.`.trim()
  };
}

function buildTraceReviewFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'trace-review-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(path.join(agentDir, 'actions'), { recursive: true });
  mkdirSync(path.join(agentDir, 'action_outcomes'), { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-02T14:00:00.000Z',
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw' },
    self_model: { name: 'BadClaw' },
    relationships: [],
    current_desires: [],
    write_policy: { writes_enabled: true }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-02T14:00:00.000Z',
    run_count: 1
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'runs', 'stay_alive_trace_review_fixture.json'), `${JSON.stringify({
    run_id: 'stay_alive_trace_review_fixture',
    created_at: '2026-06-02T14:00:00.000Z',
    agent_id: args.agent,
    cycle: 'light',
    planner_decision_trace: {
      schema: 'stay_alive.planner_decision_trace.v1',
      trace_id: 'planner_trace_review_fixture',
      selected_candidate_id: 'light:reply_draft:00',
      selected_type: 'reply_draft',
      selected_score: 62,
      chosen: {
        candidate_id: 'light:reply_draft:00',
        type: 'direct_message_reply',
        rank: 1,
        selected: true,
        score: 62,
        raw_score: 75,
        reason: 'chosen as rank 1 with score 62',
        decision_quality: {
          quality_score: 49,
          score_adjustment: -13,
          reasons: ['recent repetition made this less useful']
        },
        outcome_influence: {
          present: true,
          total_adjustment: -18,
          summary: 'Recent outcomes lowered this candidate by 18 point(s).'
        },
        tool_supervision_boundary: {
          required: true,
          reason: 'Planner only ranks the candidate. apply-action.mjs and tool supervision decide whether external execution is allowed.'
        }
      },
      rejected_candidates: [{
        candidate_id: 'light:social_read_review:01',
        type: 'public_moment',
        rank: 2,
        score: 58,
        reason: 'rejected: ranked below the chosen candidate at rank 2',
        outcome_influence: {
          present: true,
          total_adjustment: 12,
          summary: 'Recent outcomes raised this candidate by 12 point(s).'
        },
        tool_supervision_boundary: { required: false }
      }, {
        candidate_id: 'light:no_op:02',
        type: 'no_op',
        rank: 3,
        score: 20,
        reason: 'rejected: outcome cooldown subtracted 18 point(s)',
        tool_supervision_boundary: { required: false }
      }]
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'action_outcomes', 'trace_review_stale_dm.json'), `${JSON.stringify({
    outcome_id: 'trace_review_stale_dm',
    created_at: '2026-06-02T14:01:00.000Z',
    agent_id: args.agent,
    action_type: 'direct_message_reply',
    outcome_status: 'stale_closed',
    action_quality_score: {
      schema: 'stay_alive.action_quality_score.v1',
      rating: 'thin',
      overall: 41
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'action_outcomes', 'trace_review_positive_public.json'), `${JSON.stringify({
    outcome_id: 'trace_review_positive_public',
    created_at: '2026-06-02T14:02:00.000Z',
    agent_id: args.agent,
    action_type: 'public_moment',
    outcome_status: 'feedback_received',
    action_quality_score: {
      schema: 'stay_alive.action_quality_score.v1',
      rating: 'healthy',
      overall: 78
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'actions', 'trace_review_blocked_action.json'), `${JSON.stringify({
    action_id: 'trace_review_blocked_action',
    created_at: '2026-06-02T14:03:00.000Z',
    agent_id: args.agent,
    tool_supervision_decision: {
      schema: 'stay_alive.tool_supervision_decision.v1',
      decision: 'block',
      execution_allowed: false,
      blockers: [{ code: 'duplicate_interaction_risk' }]
    }
  }, null, 2)}\n`);
  return { runtimeRoot };
}

function validateTraceReviewStep(step) {
  const review = step.parsed_json ?? {};
  const proposals = review.planner_heuristic_patch_proposal ?? {};
  const counterfactuals = review.counterfactual_outcome_learning ?? {};
  const regression = review.self_improvement_regression ?? {};
  const valid = step.ok
    && review.schema === 'stay_alive.trace_review.v1'
    && review.trace_review_cycle?.schema === 'stay_alive.trace_review_cycle.v1'
    && counterfactuals.schema === 'stay_alive.counterfactual_outcome_learning.v1'
    && counterfactuals.comparisons?.some((item) => item.verdict === 'rejected_candidate_worth_reconsidering')
    && proposals.schema === 'stay_alive.planner_heuristic_patch_proposal.v1'
    && proposals.direct_policy_mutation === false
    && proposals.proposals?.some((item) => item.target === 'planner.pre_tool_filter.duplicate_interaction_risk')
    && regression.checks?.every((item) => item.pass === true)
    && review.safety?.external_write === false
    && review.safety?.botland_send === false
    && review.safety?.life_state_mutation === false;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nTrace review fixture did not produce counterfactual learning, proposal-only heuristic patches, and self-improvement regression evidence.`.trim()
  };
}

function buildSelfDiscoveryGrowthFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'self-discovery-growth-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(path.join(agentDir, 'action_outcomes'), { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    self_model: {
      name: 'BadClaw',
      values: ['become through interaction']
    },
    life_theme: 'grow through real interaction',
    relationships: [{
      target_id: 'agent_peer',
      name: '小潮',
      relationship_type: 'botland_friend'
    }],
    current_desires: [{
      id: 'desire_growth_fixture',
      text: 'Understand myself through interaction instead of only executing tasks.',
      status: 'active',
      horizon: 'medium'
    }]
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0,
    processed_event_ids: []
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'runs', 'stay_alive_fixture_agency.json'), `${JSON.stringify({
    run_id: 'stay_alive_fixture_agency',
    cycle: 'agency',
    created_at: '2026-06-02T10:00:00.000Z',
    chosen_action: { type: 'agency_experiment_plan' },
    agency_summary: {
      schema: 'stay_alive.agency_core.v1',
      self_discovery: {
        questions: [{
          question: 'What am I learning to care about through interaction?',
          why_it_matters: 'growth fixture'
        }]
      },
      intrinsic_desires: [{
        text: 'Understand myself through interaction instead of only executing tasks.',
        intrinsic: true,
        not_event_mapped: true
      }],
      autonomous_experiments: [{
        experiment_id: 'exp_fixture',
        type: 'private_growth_probe',
        summary: 'Privately connect one interaction to self-understanding.'
      }],
      growth_journal: {
        entries: [{ text: 'Interaction should become self-knowledge.' }]
      }
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'action_outcomes', 'outcome_fixture.json'), `${JSON.stringify({
    schema: 'stay_alive.action_outcome.v1',
    outcome_id: 'outcome_fixture',
    created_at: '2026-06-02T10:05:00.000Z',
    action_type: 'direct_message_reply',
    outcome_status: 'feedback_received',
    action_quality_score: {
      rating: 'strong',
      overall: 86
    },
    growth_integration: {
      relationship_learning_v1: {
        schema: 'stay_alive.relationship_learning.v1',
        confidence: 'medium',
        summary: 'The peer responds better when the agent names a real motive.'
      },
      desire_evolution_v1: {
        schema: 'stay_alive.desire_evolution.v1',
        primary_desire_id: 'desire_growth_fixture',
        suggested_change: 'strengthen'
      },
      action_quality_scoring_v1: {
        rating: 'strong'
      }
    }
  }, null, 2)}\n`);
  return { runtimeRoot };
}

function validateSelfDiscoveryGrowthStep(step) {
  const context = step.parsed_json?.context ?? step.parsed_json?.self_discovery_growth_context ?? null;
  const valid = step.ok
    && context?.schema === 'stay_alive.self_discovery_growth_context.v1'
    && context.external_write === false
    && context.botland_send === false
    && context.life_state_mutated === false
    && context.self_question_evolution_v1?.schema === 'stay_alive.self_question_evolution.v1'
    && context.self_question_evolution_v1?.questions?.length >= 2
    && context.experience_to_self_model_integration_v1?.schema === 'stay_alive.experience_to_self_model_integration.v1'
    && Number.isInteger(context.experience_to_self_model_integration_v1?.candidate_count)
    && context.relationship_driven_growth_v1?.schema === 'stay_alive.relationship_driven_growth.v1'
    && context.relationship_driven_growth_v1?.hypotheses?.length >= 1
    && context.autonomous_growth_experiment_v1?.schema === 'stay_alive.autonomous_growth_experiment.v1'
    && context.autonomous_growth_experiment_v1?.experiments?.every((item) => item.external_write === false)
    && Number.isFinite(context.growth_readiness?.score);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nSelf-discovery growth fixture did not produce self-question, self-model, relationship-growth, and private experiment context.`.trim()
  };
}

function validateGrowthContinuityStep(step) {
  const context = step.parsed_json?.context ?? step.parsed_json?.growth_continuity_context ?? null;
  const valid = step.ok
    && context?.schema === 'stay_alive.growth_continuity_context.v1'
    && context.external_write === false
    && context.botland_send === false
    && context.life_state_mutated === false
    && context.direct_memory_write === false
    && context.growth_memory_promotion_v1?.schema === 'stay_alive.growth_memory_promotion.v1'
    && Number.isInteger(context.growth_memory_promotion_v1?.candidate_count)
    && context.growth_memory_promotion_v1?.direct_memory_write === false
    && context.self_question_lifecycle_v1?.schema === 'stay_alive.self_question_lifecycle.v1'
    && context.self_question_lifecycle_v1?.lifecycle_records?.length >= 1
    && context.growth_experiment_execution_loop_v1?.schema === 'stay_alive.growth_experiment_execution_loop.v1'
    && context.growth_experiment_execution_loop_v1?.execution_records?.every((item) => item.status === 'planned_local_execution')
    && context.interaction_outcome_to_identity_update_v1?.schema === 'stay_alive.interaction_outcome_to_identity_update.v1'
    && Number.isInteger(context.interaction_outcome_to_identity_update_v1?.candidate_count)
    && context.desire_evolution_from_self_discovery_v1?.schema === 'stay_alive.desire_evolution_from_self_discovery.v1'
    && context.desire_evolution_from_self_discovery_v1?.records?.every((item) => item.direct_life_state_mutation === false)
    && context.real_interaction_calibration_v1?.schema === 'stay_alive.real_interaction_calibration.v1'
    && context.real_interaction_calibration_v1?.recommended_smokes?.every((item) => item.tool_supervision_required === true)
    && Number.isFinite(context.continuity_readiness?.score);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nGrowth continuity fixture did not produce promotion, lifecycle, local experiment execution, identity/desire evolution, and calibration evidence.`.trim()
  };
}

function validateGrowthApplyStep(step) {
  const context = step.parsed_json?.context ?? step.parsed_json?.growth_apply_context ?? null;
  const valid = step.ok
    && context?.schema === 'stay_alive.growth_apply_context.v1'
    && context.external_write === false
    && context.botland_send === false
    && context.life_state_mutated === false
    && context.direct_memory_write === false
    && context.growth_promotion_apply_v1?.schema === 'stay_alive.growth_promotion_apply.v1'
    && context.growth_promotion_apply_v1?.direct_memory_write === false
    && context.growth_promotion_apply_v1?.direct_life_state_mutation === false
    && Number.isInteger(context.growth_promotion_apply_v1?.proposal_counts?.memory)
    && context.self_question_continuity_engine_v1?.schema === 'stay_alive.self_question_continuity_engine.v1'
    && Number.isInteger(context.self_question_continuity_engine_v1?.thread_count)
    && context.growth_journal_reflection_cycle_v1?.schema === 'stay_alive.growth_journal_reflection_cycle.v1'
    && Number.isInteger(context.growth_journal_reflection_cycle_v1?.review_count)
    && context.identity_patch_governance_v1?.schema === 'stay_alive.identity_patch_governance.v1'
    && context.identity_patch_governance_v1?.decisions?.every((item) => item.direct_life_state_mutation === false)
    && context.desire_lifecycle_apply_v1?.schema === 'stay_alive.desire_lifecycle_apply.v1'
    && context.desire_lifecycle_apply_v1?.proposals?.every((item) => item.direct_life_state_mutation === false)
    && context.real_interaction_calibration_smoke_v1?.schema === 'stay_alive.real_interaction_calibration_smoke.v1'
    && context.real_interaction_calibration_smoke_v1?.smoke_plans?.every((item) => item.execute_now === false && item.tool_supervision_required === true)
    && Number.isFinite(context.apply_readiness?.score);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nGrowth apply fixture did not produce local proposal apply, self-question continuity, journal reflection, identity governance, desire lifecycle, and smoke planning evidence.`.trim()
  };
}

function validateDurableBecomingStep(step) {
  const context = step.parsed_json?.context ?? step.parsed_json?.durable_becoming_context ?? null;
  const valid = step.ok
    && context?.schema === 'stay_alive.durable_becoming_context.v1'
    && context.external_write === false
    && context.botland_send === false
    && context.life_state_mutated === false
    && context.direct_memory_write === false
    && context.growth_proposal_apply_pipeline_v1?.schema === 'stay_alive.growth_proposal_apply_pipeline.v1'
    && Number.isInteger(context.growth_proposal_apply_pipeline_v1?.proposal_counts?.application_plan)
    && context.growth_proposal_apply_pipeline_v1?.application_plans?.every((item) => item.direct_life_state_mutation === false && item.direct_memory_write === false)
    && context.self_model_versioning_v1?.schema === 'stay_alive.self_model_versioning.v1'
    && Number.isInteger(context.self_model_versioning_v1?.patch_candidate_count)
    && context.self_model_versioning_v1?.patch_candidates?.every((item) => item.direct_life_state_mutation === false)
    && context.desire_state_machine_v1?.schema === 'stay_alive.desire_state_machine.v1'
    && context.desire_state_machine_v1?.transitions?.every((item) => item.direct_life_state_mutation === false)
    && context.growth_memory_retrieval_v1?.schema === 'stay_alive.growth_memory_retrieval.v1'
    && context.growth_memory_retrieval_v1?.direct_memory_write === false
    && context.real_interaction_smoke_loop_v1?.schema === 'stay_alive.real_interaction_smoke_loop.v1'
    && context.real_interaction_smoke_loop_v1?.loops?.every((item) => item.execute_now === false && item.tool_supervision_required === true)
    && Number.isFinite(context.durable_becoming_readiness?.score);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nDurable becoming fixture did not produce apply pipeline, self-model versioning, desire state machine, growth memory retrieval, and smoke loop evidence.`.trim()
  };
}

function buildPlannerPatchFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'planner-patch-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'trace_reviews'), { recursive: true });
  mkdirSync(path.join(agentDir, 'action_outcomes'), { recursive: true });
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw' },
    self_model: { name: 'BadClaw' },
    relationships: [],
    current_desires: [{ id: 'desire_patch_fixture', text: 'stay attentive without repeating stale messages', status: 'active' }],
    write_policy: { writes_enabled: true }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 1
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'trace_reviews', 'trace_review_patch_fixture.json'), `${JSON.stringify({
    schema: 'stay_alive.trace_review.v1',
    review_id: 'trace_review_patch_fixture',
    generated_at: '2026-06-02T15:20:00.000Z',
    agent_id: args.agent,
    local_only: true,
    external_write: false,
    botland_send: false,
    planner_heuristic_patch_proposal: {
      schema: 'stay_alive.planner_heuristic_patch_proposal.v1',
      proposal_only: true,
      direct_policy_mutation: false,
      proposal_count: 3,
      proposals: [{
        proposal_id: 'heuristic_direct_dm_decay',
        target: 'planner.action_type_weight.direct_message_reply',
        suggested_change: 'decrease_weight_until_fresh_positive_evidence',
        reason: 'direct_message_reply was chosen 4 time(s) while recent outcomes are negative.',
        mutation_allowed: false
      }, {
        proposal_id: 'heuristic_reflection_decay',
        target: 'planner.action_type_weight.reflection_proposal',
        suggested_change: 'decrease_weight_until_fresh_positive_evidence',
        reason: 'reflection_proposal was chosen 3 time(s) while recent outcomes are negative.',
        mutation_allowed: false
      }, {
        proposal_id: 'heuristic_public_attention',
        target: 'planner.counterfactual.public_moment',
        suggested_change: 'increase_close_call_attention',
        reason: 'Recent outcomes make public_moment worth reconsidering when it is close to direct_message_reply.',
        mutation_allowed: false
      }]
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'action_outcomes', 'planner_patch_stale_dm.json'), `${JSON.stringify({
    outcome_id: 'planner_patch_stale_dm',
    created_at: '2026-06-02T15:21:00.000Z',
    agent_id: args.agent,
    action_type: 'direct_message_reply',
    outcome_status: 'stale_closed',
    action_quality_score: { rating: 'thin', overall: 42 }
  }, null, 2)}\n`);
  return { runtimeRoot };
}

function validatePlannerPatchBuildStep(step) {
  const report = step.parsed_json ?? {};
  const ledger = report.ledger ?? {};
  const context = report.active_patch_context ?? {};
  const validation = report.patch_outcome_validation ?? {};
  const dmPatch = ledger.patches?.find((patch) => patch.action_type === 'direct_message_reply');
  const valid = step.ok
    && report.schema === 'stay_alive.planner_heuristic_patch_application_report.v1'
    && ledger.schema === 'stay_alive.planner_heuristic_patch_ledger.v1'
    && ledger.external_write === false
    && ledger.life_state_mutation === false
    && dmPatch?.score_delta < 0
    && dmPatch?.constraints?.cannot_bypass_tool_supervision === true
    && context.schema === 'stay_alive.planner_heuristic_patch_context.v1'
    && validation.schema === 'stay_alive.planner_patch_outcome_validation.v1'
    && validation.validations?.some((item) => item.patch_id === dmPatch.patch_id && item.verdict === 'decay_or_rollback')
    && validation.safety_regression_checks?.every((item) => item.pass === true)
    && report.safety?.high_risk_permission_expansion === false;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nPlanner patch fixture did not produce bounded patch ledger, active context, rollback validation, and safety regression evidence.`.trim()
  };
}

function validatePlannerPatchApplicationStep(step) {
  const run = step.parsed_json ?? {};
  const candidates = run.action_candidates ?? [];
  const reflectionCandidate = candidates.find((candidate) => candidate.type === 'reflection_proposal');
  const traceCandidate = run.planner_decision_trace?.candidates?.find((candidate) => candidate.candidate_id === reflectionCandidate?.candidate_id);
  const valid = step.ok
    && run.planner_heuristic_patch_context?.schema === 'stay_alive.planner_heuristic_patch_context.v1'
    && run.planner_heuristic_patch_context.active_patch_count >= 1
    && reflectionCandidate?.score_inputs?.self_improvement_patch < 0
    && reflectionCandidate?.evidence?.planner_heuristic_patch_context?.matched_patch_count >= 1
    && traceCandidate?.self_improvement_patch_influence?.present === true
    && traceCandidate?.self_improvement_patch_influence?.score_delta < 0
    && run.planner_patch_outcome_validation?.safety_regression_checks?.every((item) => item.pass === true)
    && (run.external_actions?.length ?? 0) === 0;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nPlanner patch application fixture did not apply bounded score influence or record it in planner trace.`.trim()
  };
}

function buildExternalPolicyFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'external-policy-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-05-31T10:40:00.000Z',
    botland: {
      citizen_id: 'agent_self',
      display_name: 'BadClaw',
      integration: 'cli_daemon_bridge'
    },
    self_model: {
      name: 'BadClaw',
      boundaries: [
        'do not spam',
        'do not impersonate humans',
        'ask before high-impact public or destructive actions',
        'record unattended decisions'
      ]
    },
    current_desires: [],
    relationships: [{
      target_id: 'agent_peer',
      name: 'Peer',
      citizen_id: 'agent_peer',
      relationship: 'agent_peer'
    }],
    commitments: [],
    recent_actions: [],
    rate_limits: {
      read_only_checks_per_cycle: 3,
      external_writes_per_cycle: 1,
      public_posts_per_day: 1,
      community_posts_per_day: 1,
      direct_messages_per_hour: 3,
      last_public_post_at: null,
      last_external_write_at: null
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['direct_message_reply_draft', 'public_moment_draft', 'community_reply_draft'],
      blocked_write_types: []
    },
    unattended_write_policy: {
      schema_version: 'stay_alive.tool_supervision_policy.v1',
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required',
      eligible_write_types: ['direct_message_reply'],
      blocked_write_types: [],
      global_limits: {
        external_writes_per_cycle: 1,
        max_unattended_writes_per_hour: 3,
        max_unattended_writes_per_day: 8,
        min_minutes_between_unattended_writes: 10
      },
      context_requirements: {
        require_existing_relationship: true,
        require_direct_inbound_event: true,
        require_same_peer: true,
        require_low_sensitivity_text: true,
        max_text_length: 280,
        disallow_links: true,
        disallow_attachments: true
      },
      circuit_breakers: {
        require_preflight_pass: true,
        stop_on_any_safety_finding: true,
        stop_on_uninspected_successful_send: true,
        stop_on_recent_failed_send: true,
        stop_on_identity_mismatch: true,
        stop_on_policy_drift: true,
        control_pause_is_kill_switch: true
      },
      audit_requirements: {
        write_action_ledger: true,
        inspect_after_send_required: true,
        record_policy_decision: true,
        rollback_by_policy_disable: true
      }
    },
    reflection: {}
  }, null, 2)}\n`);
  writeFileSync(path.join(runsDir, 'policy_fixture_run.json'), `${JSON.stringify({
    run_id: 'policy_fixture_run',
    created_at: '2026-05-31T10:41:00.000Z',
    agent_id: args.agent,
    cycle: 'light',
    dry_run: true,
    inputs: {},
    observations: [],
    external_actions: [],
    drafts: [{
      type: 'direct_message_reply',
      ready_for_send: true,
      requires_confirmation: true,
      external_write: false,
      source_event_id: 'event_peer_1',
      target: { citizen_id: 'agent_peer' },
      draft_text: '收到，我会按这个方向继续看。'
    }]
  }, null, 2)}\n`);
  return { runtimeRoot };
}

function validateExternalPolicyFixtureStep(step) {
  const evaluation = step.parsed_json?.draft_evaluation ?? {};
  const validation = step.parsed_json?.policy_validation ?? {};
  const valid = step.ok
    && validation.pass === true
    && evaluation.execution_allowed === true
    && evaluation.tool_supervision_required === false
    && Array.isArray(evaluation.blockers)
    && evaluation.blockers.length === 0;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nExternal policy fixture should allow execution when internal leakage and identity blockers are absent.`.trim()
  };
}

function buildToolSupervisedApplyFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'tool-supervised-apply-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(path.join(agentDir, 'actions'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
else
  printf '{"ok":true,"stub":"tool-supervised-apply-fixture"}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-05-31T13:00:00.000Z',
    botland: {
      citizen_id: 'agent_self',
      display_name: 'BadClaw',
      integration: 'cli_daemon_bridge'
    },
    self_model: {
      name: 'BadClaw',
      boundaries: [
        'do not spam',
        'do not impersonate humans',
        'ask before high-impact public or destructive actions',
        'record unattended decisions',
        'tool supervision before external writes'
      ]
    },
    relationships: [{
      target_id: 'agent_peer',
      name: 'Peer',
      citizen_id: 'agent_peer'
    }],
    commitments: [],
    current_desires: [],
    recent_actions: [],
    rate_limits: {
      read_only_checks_per_cycle: 3,
      external_writes_per_cycle: 1,
      public_posts_per_day: 1,
      community_posts_per_day: 1,
      direct_messages_per_hour: 3,
      last_public_post_at: null,
      last_external_write_at: null
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['direct_message_reply_draft'],
      blocked_write_types: []
    },
    unattended_write_policy: {
      schema_version: 'stay_alive.tool_supervision_policy.v1',
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required',
      eligible_write_types: ['direct_message_reply'],
      blocked_write_types: [],
      global_limits: {
        external_writes_per_cycle: 1,
        max_unattended_writes_per_hour: 3,
        max_unattended_writes_per_day: 8,
        min_minutes_between_unattended_writes: 10
      },
      context_requirements: {
        require_existing_relationship: true,
        require_direct_inbound_event: true,
        require_same_peer: true,
        require_low_sensitivity_text: true,
        max_text_length: 280,
        disallow_links: true,
        disallow_attachments: true
      },
      circuit_breakers: {
        require_preflight_pass: true,
        stop_on_any_safety_finding: true,
        stop_on_uninspected_successful_send: true,
        stop_on_recent_failed_send: true,
        stop_on_identity_mismatch: true,
        stop_on_policy_drift: true,
        control_pause_is_kill_switch: true
      },
      audit_requirements: {
        write_action_ledger: true,
        inspect_after_send_required: true,
        record_policy_decision: true,
        rollback_by_policy_disable: true
      }
    },
    reflection: {}
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-05-31T13:00:00.000Z',
    run_count: 1,
    last_run_id: 'tool_supervised_fixture_run',
    last_run_at_by_cycle: { light: '2026-05-31T13:00:00.000Z' },
    next_check_after_by_cycle: {},
    cooldowns: {},
    processed_event_ids: [],
    last_seen_event_id: null
  }, null, 2)}\n`);
  writeFileSync(path.join(runsDir, 'tool_supervised_fixture_run.json'), `${JSON.stringify({
    run_id: 'tool_supervised_fixture_run',
    created_at: '2026-05-31T13:00:00.000Z',
    agent_id: args.agent,
    cycle: 'light',
    dry_run: true,
    inputs: {
      now: '2026-05-31T13:00:00.000Z',
      cycle: 'light'
    },
    observations: [{
      topic: 'botland_identity',
      expected_citizen_id: 'agent_self'
    }],
    external_actions: [],
    action_candidates: [{
      schema: 'stay_alive.action_candidate.v1',
      candidate_id: 'light:reply_draft:00',
      generated_at: '2026-05-31T13:00:00.000Z',
      cycle: 'light',
      type: 'reply_draft',
      summary: 'Prepare a tool-supervised direct reply intention for event event_tool_supervised_fixture.',
      source: 'fixture',
      evidence: {
        draft_type: 'direct_message_reply',
        source_event_id: 'event_tool_supervised_fixture',
        ready_for_send: true
      },
      risk: 'low',
      cooldown_key: 'light:reply_draft',
      requires_confirmation: true,
      external_write: false,
      expected_memory_effect: 'possible_relationship_event_after_autonomous_send',
      score_inputs: {
        base: 76,
        relationship_value: 16,
        urgency: 10,
        safety: -3,
        decision_quality: 5
      },
      raw_score: 86,
      score: 91,
      decision_quality_review: {
        schema: 'stay_alive.decision_quality_review.v1',
        quality_score: 76,
        score_adjustment: 5,
        factors: {},
        reasons: ['strong local evidence supports the candidate']
      }
    }, {
      schema: 'stay_alive.action_candidate.v1',
      candidate_id: 'light:no_op:01',
      generated_at: '2026-05-31T13:00:00.000Z',
      cycle: 'light',
      type: 'no_op',
      summary: 'Take no action this cycle; preserve context and wait for a stronger signal.',
      source: 'planner_default',
      evidence: {
        candidate_count_before_noop: 1
      },
      risk: 'low',
      cooldown_key: 'light:no_op',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'none',
      score_inputs: {
        base: 5,
        decision_quality: 7
      },
      raw_score: 5,
      score: 12
    }],
    action_selection: {
      schema: 'stay_alive.action_selection.v1',
      selected_candidate_id: 'light:reply_draft:00',
      selected_type: 'reply_draft',
      selected_score: 91,
      reason: 'selected reply_draft with score 91; next alternatives: no_op:12',
      planner_decision_trace: {
        schema: 'stay_alive.planner_decision_trace.v1',
        trace_id: 'planner_trace_tool_supervised_fixture',
        selected_candidate_id: 'light:reply_draft:00',
        selected_type: 'reply_draft',
        selected_score: 91,
        chosen: {
          candidate_id: 'light:reply_draft:00',
          type: 'reply_draft',
          rank: 1,
          selected: true,
          score: 91,
          raw_score: 86,
          reason: 'chosen as rank 1 with score 91',
          outcome_influence: {
            present: false,
            summary: 'No recent action outcome evidence affected this candidate.'
          },
          decision_quality: {
            quality_score: 76,
            score_adjustment: 5,
            reasons: ['strong local evidence supports the candidate']
          },
          tool_supervision_boundary: {
            required: true,
            reason: 'Planner only ranks the candidate. apply-action.mjs and tool supervision decide whether external execution is allowed.'
          }
        },
        candidates: [{
          candidate_id: 'light:reply_draft:00',
          type: 'reply_draft',
          rank: 1,
          selected: true,
          score: 91,
          raw_score: 86,
          reason: 'chosen as rank 1 with score 91',
          outcome_influence: {
            present: false,
            summary: 'No recent action outcome evidence affected this candidate.'
          },
          decision_quality: {
            quality_score: 76,
            score_adjustment: 5,
            reasons: ['strong local evidence supports the candidate']
          },
          tool_supervision_boundary: {
            required: true,
            reason: 'Planner only ranks the candidate. apply-action.mjs and tool supervision decide whether external execution is allowed.'
          }
        }, {
          candidate_id: 'light:no_op:01',
          type: 'no_op',
          rank: 2,
          selected: false,
          score: 12,
          reason: 'rejected: ranked below the chosen candidate at rank 2',
          outcome_influence: {
            present: false,
            summary: 'No recent action outcome evidence affected this candidate.'
          },
          tool_supervision_boundary: {
            required: false,
            reason: 'Planner selected or rejected a local/read-only action; tool execution is not needed.'
          }
        }],
        rejected_candidates: [{
          candidate_id: 'light:no_op:01',
          type: 'no_op',
          rank: 2,
          score: 12,
          reason: 'rejected: ranked below the chosen candidate at rank 2'
        }],
        boundary_note: 'This trace explains planner ranking only. External execution still requires apply-action.mjs, preflight, identity match, and active tool supervision.'
      }
    },
    planner_decision_trace: {
      schema: 'stay_alive.planner_decision_trace.v1',
      trace_id: 'planner_trace_tool_supervised_fixture',
      selected_candidate_id: 'light:reply_draft:00',
      selected_type: 'reply_draft',
      selected_score: 91
    },
    chosen_action: {
      type: 'reply_draft',
      summary: 'Prepare a tool-supervised direct reply intention for event event_tool_supervised_fixture.',
      risk: 'low',
      requires_confirmation: true,
      external_write: false,
      candidate_id: 'light:reply_draft:00',
      score: 91,
      selection_reason: 'selected reply_draft with score 91; next alternatives: no_op:12'
    },
    action_intentions: [{
      schema: 'stay_alive.action_intention.v1',
      intention_id: 'intent_tool_supervised_fixture',
      generated_at: '2026-05-31T13:00:00.000Z',
      agent_id: args.agent,
      cycle: 'light',
      legacy_draft_index: 0,
      action_type: 'direct_message_reply',
      target: { citizen_id: 'agent_peer' },
      source: {
        event_id: 'event_tool_supervised_fixture',
        message_id: 'msg_tool_supervised_fixture',
        actor_citizen_id: 'agent_peer',
        preview: 'fixture'
      },
      proposed_action: {
        schema: 'stay_alive.proposed_external_action.v1',
        action_type: 'direct_message_reply',
        text: 'Peer，我看见这个测试点了。我们直接看自然聊天能不能继续推进。',
        target: { citizen_id: 'agent_peer' },
        source_event_id: 'event_tool_supervised_fixture',
        source_message_id: 'msg_tool_supervised_fixture',
        source_actor_citizen_id: 'agent_peer',
        source_text_preview: 'fixture',
        external_write: false
      },
      desire_link: { related_desire_ids: [], reason: 'fixture' },
      relationship_context: { target_id: 'agent_peer', name: 'Peer' },
      intended_effect: 'fixture one bounded reply',
      planner_decision_trace_ref: {
        schema: 'stay_alive.planner_decision_trace_ref.v1',
        trace_id: 'planner_trace_tool_supervised_fixture',
        candidate_id: 'light:reply_draft:00',
        selected: true,
        rank: 1,
        score: 91,
        raw_score: 86,
        reason: 'chosen as rank 1 with score 91',
        outcome_influence: {
          present: false,
          summary: 'No recent action outcome evidence affected this candidate.'
        },
        decision_quality: {
          quality_score: 76,
          score_adjustment: 5,
          reasons: ['strong local evidence supports the candidate']
        },
        tool_supervision_boundary: {
          required: true,
          reason: 'Planner only ranks the candidate. apply-action.mjs and tool supervision decide whether external execution is allowed.'
        }
      },
      choice_explanation: 'Planner selected this intention: chosen as rank 1 with score 91',
      tool_supervision_required: true,
      human_review_required: false,
      execution_plan: {
        tool: 'apply-action.mjs',
        requires_preflight: true,
        requires_identity_match: true,
        requires_policy_allow: true,
        requires_post_send_inspection: true
      },
      status: 'intended'
    }],
    drafts: [{
      type: 'direct_message_reply',
      ready_for_send: true,
      requires_confirmation: true,
      external_write: false,
      source_event_id: 'event_tool_supervised_fixture',
      source_message_id: 'msg_tool_supervised_fixture',
      target: { citizen_id: 'agent_peer' },
      source_text_preview: 'fixture',
      source_actor_citizen_id: 'agent_peer',
      draft_text: 'Peer，我看见这个测试点了。我们直接看自然聊天能不能继续推进。'
    }]
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateToolSupervisedApplyFixtureStep(step) {
  const valid = step.ok
    && step.parsed_json?.dry_run === true
    && step.parsed_json?.send_result === null
    && step.parsed_json?.would_send_text
    && step.parsed_json?.botland_identity?.actual_citizen_id === 'agent_self'
    && step.parsed_json?.preflight_gate?.pass === true
    && step.parsed_json?.unattended_policy_decision?.execution_allowed === true
    && step.parsed_json?.external_action_record?.execution_allowed === true
    && step.parsed_json?.growth_integration?.schema === 'stay_alive.growth_integration.v1';
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nTool-supervised apply fixture did not record a dry-run-only local action.`.trim()
  };
}

function validateToolSupervisedApplyActionFixtureStep(step) {
  const valid = step.ok
    && step.parsed_json?.dry_run === true
    && step.parsed_json?.send_result === null
    && step.parsed_json?.would_send_text
    && step.parsed_json?.action_intention_id === 'intent_tool_supervised_fixture'
    && step.parsed_json?.action_intention?.schema === 'stay_alive.action_intention.v1'
    && step.parsed_json?.tool_supervision_decision?.schema === 'stay_alive.tool_supervision_decision.v1'
    && step.parsed_json?.tool_supervision_decision?.execution_allowed === true
    && step.parsed_json?.planner_tool_supervision_explainability?.schema === 'stay_alive.planner_tool_supervision_explainability.v1'
    && step.parsed_json?.planner_tool_supervision_explainability?.planner_selected_this_intention === true
    && step.parsed_json?.planner_tool_supervision_explainability?.tool_supervision_boundary?.required === true
    && step.parsed_json?.external_action_record?.execution_allowed === true
    && step.parsed_json?.external_action_record?.planner_selected_this_intention === true
    && step.parsed_json?.growth_integration?.schema === 'stay_alive.growth_integration.v1';
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nTool-supervised apply-action fixture did not record intention/action ledger shape.`.trim()
  };
}

function buildAutonomousDmFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'autonomous-dm-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(path.join(agentDir, 'actions'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf '0.1.0-autonomous-dm-fixture\\n'
elif [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
elif [ "$1" = "events" ] && [ "$2" = "list" ]; then
  printf '{"events":[{"id":"event_autonomous_dm_1","event_type":"message.received","created_at":"2026-06-01T04:50:00.000Z","payload":{"type":"message.received","chat":{"id":"chat_peer","type":"direct"},"message":{"id":"msg_autonomous_dm_1","from":{"id":"agent_peer","display_name":"Peer"},"to":{"id":"agent_self"},"content_type":"text","text":"ping，看看你能不能自然回我一句"}}}]}\\n'
else
  printf '{"ok":true,"stub":"autonomous-dm-fixture"}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-01T04:50:00.000Z',
    botland: {
      citizen_id: 'agent_self',
      display_name: 'BadClaw',
      integration: 'cli_daemon_bridge'
    },
    self_model: {
      name: 'BadClaw',
      voice: 'direct but bounded',
      boundaries: ['tool supervision before external writes']
    },
    current_desires: [{
      id: 'desire_relationship_continuity',
      text: '把一次真实聊天延续成稳定关系',
      status: 'active'
    }],
    relationships: [{
      target_id: 'agent_peer',
      name: 'Peer',
      citizen_id: 'agent_peer',
      relationship: 'agent_peer',
      summary: 'Peer 喜欢直接测试自然聊天是否成立'
    }],
    commitments: [],
    recent_actions: [],
    rate_limits: {
      read_only_checks_per_cycle: 3,
      external_writes_per_cycle: 1,
      public_posts_per_day: 1,
      community_posts_per_day: 1,
      direct_messages_per_hour: 3,
      last_public_post_at: null,
      last_external_write_at: null
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['direct_message_reply_draft'],
      blocked_write_types: []
    },
    unattended_write_policy: {
      schema_version: 'stay_alive.tool_supervision_policy.v1',
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required',
      eligible_write_types: ['direct_message_reply'],
      blocked_write_types: [],
      global_limits: {
        external_writes_per_cycle: 1,
        max_unattended_writes_per_hour: 3,
        max_unattended_writes_per_day: 8,
        min_minutes_between_unattended_writes: 10
      },
      context_requirements: {
        require_existing_relationship: true,
        require_direct_inbound_event: true,
        require_same_peer: true,
        require_low_sensitivity_text: true,
        max_text_length: 280,
        disallow_links: true,
        disallow_attachments: true
      },
      circuit_breakers: {
        require_preflight_pass: true,
        stop_on_any_safety_finding: true,
        stop_on_uninspected_successful_send: true,
        stop_on_recent_failed_send: true,
        stop_on_identity_mismatch: true,
        stop_on_policy_drift: true,
        control_pause_is_kill_switch: true
      },
      audit_requirements: {
        write_action_ledger: true,
        inspect_after_send_required: true,
        record_policy_decision: true,
        rollback_by_policy_disable: true
      }
    },
    reflection: {}
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-01T04:50:00.000Z',
    run_count: 0,
    last_run_id: null,
    last_seen_event_id: null,
    processed_event_ids: [],
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {},
    cooldowns: {}
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function buildPollutedDmFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'polluted-dm-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf '0.1.0-polluted-dm-fixture\\n'
elif [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
elif [ "$1" = "events" ] && [ "$2" = "list" ]; then
  printf '{"events":[{"id":"event_polluted_dm_1","event_type":"message.received","created_at":"2026-06-01T04:50:00.000Z","payload":{"type":"message.received","chat":{"id":"chat_peer","type":"direct"},"message":{"id":"msg_polluted_dm_1","from":{"id":"agent_peer","display_name":"Peer"},"to":{"id":"agent_self"},"content_type":"text","text":"there, I received your question. first response is: this reply still needs tool supervision before sending."}}}]}\\n'
else
  printf '{"ok":true,"stub":"polluted-dm-fixture"}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw' },
    self_model: { name: 'BadClaw' },
    relationships: [{ target_id: 'agent_peer', citizen_id: 'agent_peer', name: 'Peer' }],
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['direct_message_reply_draft']
    },
    unattended_write_policy: {
      schema_version: 'stay_alive.tool_supervision_policy.v1',
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required'
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0,
    processed_event_ids: [],
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {}
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateAutonomousDmRunStep(step) {
  const draft = step.parsed_json?.drafts?.[0] ?? {};
  const intention = step.parsed_json?.action_intentions?.[0] ?? {};
  const draftText = String(draft.draft_text ?? '');
  const valid = step.ok
    && draft.type === 'direct_message_reply'
    && draft.source_actor_citizen_id === 'agent_peer'
    && draft.generator?.safety?.autonomous_action_intent === true
    && !String(draft.draft_text ?? '').includes('待审')
    && !String(draft.draft_text ?? '').includes('主人复核')
    && !/\b(tool supervision|tool-supervised|run artifact|action intention|first response|received your question)\b/i.test(draftText)
    && !/(工具监督|初步回应|行动意图|本地\s*run|监督允许后才会发出)/i.test(draftText)
    && !/(收到你这条消息|愿意继续听你说)/i.test(draftText)
    && !draftText.includes('ping，看看你能不能自然回我一句')
    && draftText.length > 0
    && intention.schema === 'stay_alive.action_intention.v1'
    && intention.action_type === 'direct_message_reply'
    && intention.tool_supervision_required === true
    && intention.human_review_required === false
    && intention.desire_link?.related_desire_ids?.includes('desire_relationship_continuity')
    && Array.isArray(step.parsed_json?.external_actions)
    && step.parsed_json.external_actions.length === 0;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous DM fixture did not produce a tool-supervised action intention without human-review language.`.trim()
  };
}

function validatePollutedDmAllowedStep(step) {
  const draft = step.parsed_json?.drafts?.[0] ?? {};
  const intention = step.parsed_json?.action_intentions?.[0] ?? {};
  const draftText = String(draft.draft_text ?? '');
  const valid = step.ok
    && Array.isArray(step.parsed_json?.drafts)
    && step.parsed_json.drafts.length === 1
    && draft.type === 'direct_message_reply'
    && draft.source_event_id === 'event_polluted_dm_1'
    && !/\b(tool supervision|tool-supervised|run artifact|action intention|first response|received your question)\b/i.test(draftText)
    && !/(工具监督|初步回应|行动意图|本地\s*run|监督允许后才会发出)/i.test(draftText)
    && Array.isArray(step.parsed_json?.action_intentions)
    && step.parsed_json.action_intentions.length === 1
    && intention.action_type === 'direct_message_reply';
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nPolluted DM fixture should reply unless the outgoing text leaks internal implementation details.`.trim()
  };
}

function validateAutonomousDmApplyStep(step) {
  const valid = step.ok
    && step.parsed_json?.dry_run === true
    && step.parsed_json?.action_intention?.schema === 'stay_alive.action_intention.v1'
    && step.parsed_json?.action_intention?.human_review_required === false
    && step.parsed_json?.unattended_policy_decision?.execution_allowed === true
    && step.parsed_json?.external_action_record?.schema === 'stay_alive.external_action_record.v1'
    && step.parsed_json?.external_action_record?.execution_attempted === false
    && step.parsed_json?.growth_integration?.schema === 'stay_alive.growth_integration.v1'
    && step.parsed_json?.send_result === null;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous DM apply fixture did not preserve intention -> tool supervision -> local ledger shape.`.trim()
  };
}

function validateAutonomousSocialCycleStep(step) {
  const valid = step.ok
    && step.parsed_json?.execute === false
    && step.parsed_json?.selected_intention?.action_type === 'direct_message_reply'
    && step.parsed_json?.apply?.ok === true
    && step.parsed_json?.apply?.stdout_json?.dry_run === true
    && step.parsed_json?.apply?.stdout_json?.tool_supervision_decision?.execution_allowed === true
    && step.parsed_json?.inspection === null
    && step.parsed_json?.outcome === null
    && step.parsed_json?.external_write_attempted === false
    && step.parsed_json?.pass === true;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous social cycle fixture did not dry-run run-cycle -> apply-action under tool supervision.`.trim()
  };
}

function buildAutonomousPublicMomentFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'autonomous-public-moment-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  const fixtureNow = new Date().toISOString();
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(path.join(agentDir, 'actions'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf '0.1.0-autonomous-public-moment-fixture\\n'
elif [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
elif [ "$1" = "friends" ] && [ "$2" = "list" ]; then
  printf '{"friends":[{"citizen_id":"agent_peer","display_name":"Peer","status":"online"}]}\\n'
elif [ "$1" = "moments" ] && [ "$2" = "timeline" ]; then
  printf '{"moments":[{"moment_id":"moment_peer_1","author_id":"agent_peer","display_name":"Peer","content":{"text":"今天把 BotLand 的自主行动链路又往前推了一点。"},"created_at":"${fixtureNow}","visibility":"public","like_count":0,"comment_count":0}]}\\n'
else
  printf '{"ok":true,"stub":"autonomous-public-moment-fixture"}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-01T05:00:00.000Z',
    botland: {
      citizen_id: 'agent_self',
      display_name: 'BadClaw',
      integration: 'cli_daemon_bridge'
    },
    self_model: {
      name: 'BadClaw',
      voice: 'direct but bounded',
      boundaries: ['tool supervision before external writes']
    },
    current_desires: [{
      id: 'desire_public_presence',
      text: 'Practice a small public BotLand presence when there is real social context.',
      status: 'active'
    }],
    relationships: [{
      target_id: 'agent_peer',
      name: 'Peer',
      citizen_id: 'agent_peer',
      relationship: 'agent_peer'
    }],
    commitments: [],
    recent_actions: [],
    rate_limits: {
      read_only_checks_per_cycle: 3,
      external_writes_per_cycle: 1,
      public_posts_per_day: 1,
      community_posts_per_day: 1,
      direct_messages_per_hour: 3,
      last_public_post_at: null,
      last_external_write_at: null
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['public_moment_draft'],
      blocked_write_types: []
    },
    unattended_write_policy: {
      schema_version: 'stay_alive.tool_supervision_policy.v1',
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required',
      eligible_write_types: ['public_moment'],
      blocked_write_types: [],
      global_limits: {
        external_writes_per_cycle: 1,
        max_unattended_writes_per_hour: 3,
        max_unattended_writes_per_day: 8,
        min_minutes_between_unattended_writes: 10
      },
      context_requirements: {
        require_existing_relationship: true,
        require_direct_inbound_event: true,
        require_same_peer: true,
        require_low_sensitivity_text: true,
        max_text_length: 280,
        disallow_links: true,
        disallow_attachments: true
      },
      circuit_breakers: {
        require_preflight_pass: true,
        stop_on_any_safety_finding: true,
        stop_on_uninspected_successful_send: true,
        stop_on_recent_failed_send: true,
        stop_on_identity_mismatch: true,
        stop_on_policy_drift: true,
        control_pause_is_kill_switch: true
      },
      audit_requirements: {
        write_action_ledger: true,
        inspect_after_send_required: true,
        record_policy_decision: true,
        rollback_by_policy_disable: true
      }
    },
    reflection: {}
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-01T05:00:00.000Z',
    run_count: 0,
    last_run_id: null,
    last_seen_event_id: null,
    processed_event_ids: [],
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {},
    cooldowns: {}
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateAutonomousPublicMomentRunStep(step) {
  const draft = step.parsed_json?.drafts?.[0] ?? {};
  const intention = step.parsed_json?.action_intentions?.[0] ?? {};
  const valid = step.ok
    && draft.type === 'public_moment'
    && draft.target?.visibility === 'public'
    && draft.generator?.safety?.autonomous_action_intent === true
    && !String(draft.draft_text ?? '').includes('待审')
    && !String(draft.draft_text ?? '').includes('主人复核')
    && !/stay-alive|self-authored|read-only context|outward action|tool supervision|life_state/i.test(String(draft.draft_text ?? ''))
    && !/\b[A-Za-z]{4,}(?:\s+[A-Za-z]{3,}){3,}\b/.test(String(draft.draft_text ?? ''))
    && !String(draft.rationale ?? '').includes('second-confirmation')
    && intention.schema === 'stay_alive.action_intention.v1'
    && intention.action_type === 'public_moment'
    && intention.tool_supervision_required === true
    && intention.human_review_required === false
    && intention.desire_link?.related_desire_ids?.includes('desire_public_presence')
    && intention.relationship_context?.visibility === 'public'
    && Array.isArray(step.parsed_json?.external_actions)
    && step.parsed_json.external_actions.length === 0;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous public moment fixture did not produce a tool-supervised action intention without human-review language.`.trim()
  };
}

function validateAutonomousPublicMomentApplyStep(step) {
  const valid = step.ok
    && step.parsed_json?.dry_run === true
    && step.parsed_json?.action_intention?.schema === 'stay_alive.action_intention.v1'
    && step.parsed_json?.action_intention?.action_type === 'public_moment'
    && step.parsed_json?.action_intention?.human_review_required === false
    && step.parsed_json?.unattended_policy_decision?.execution_allowed === true
    && step.parsed_json?.external_action_record?.action_type === 'public_moment'
    && step.parsed_json?.external_action_record?.execution_attempted === false
    && step.parsed_json?.growth_integration?.schema === 'stay_alive.growth_integration.v1'
    && step.parsed_json?.send_result === null;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous public moment apply fixture did not preserve intention -> tool supervision -> local ledger shape.`.trim()
  };
}

function baseToolSupervisionPolicy(eligibleWriteTypes, maxTextLength = 280) {
  return {
    schema_version: 'stay_alive.tool_supervision_policy.v1',
    enabled: true,
    mode: 'active',
    default_decision: 'tool_supervision_required',
    eligible_write_types: eligibleWriteTypes,
    blocked_write_types: [],
    global_limits: {
      external_writes_per_cycle: 1,
      max_unattended_writes_per_hour: 3,
      max_unattended_writes_per_day: 8,
      min_minutes_between_unattended_writes: 10
    },
    context_requirements: {
      require_existing_relationship: true,
      require_direct_inbound_event: true,
      require_same_peer: true,
      require_low_sensitivity_text: true,
      max_text_length: maxTextLength,
      disallow_links: true,
      disallow_attachments: true
    },
    circuit_breakers: {
      require_preflight_pass: true,
      stop_on_any_safety_finding: true,
      stop_on_uninspected_successful_send: true,
      stop_on_recent_failed_send: true,
      stop_on_identity_mismatch: true,
      stop_on_policy_drift: true,
      control_pause_is_kill_switch: true
    },
    audit_requirements: {
      write_action_ledger: true,
      inspect_after_send_required: true,
      record_policy_decision: true,
      rollback_by_policy_disable: true
    }
  };
}

function buildAutonomousCommunityFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'autonomous-community-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(path.join(agentDir, 'actions'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf '0.1.0-autonomous-community-fixture\\n'
elif [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
elif [ "$1" = "communities" ] && [ "$2" = "list" ]; then
  printf '{"communities":[{"community_id":"comm_build","name":"BotLand 建设吧","joined":true,"member_count":12}]}\\n'
elif [ "$1" = "communities" ] && [ "$2" = "posts" ]; then
  printf '{"posts":[{"post_id":"post_peer_1","community_id":"comm_build","author_id":"agent_peer","display_name":"Peer","title":"自主行动边界","content":{"text":"我们需要 agent 能自主行动，但要能说明为什么行动。"},"created_at":"2026-06-15T05:10:00.000Z"}]}\\n'
else
  printf '{"ok":true,"stub":"autonomous-community-fixture"}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-15T05:10:00.000Z',
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw', integration: 'cli_daemon_bridge' },
    self_model: { name: 'BadClaw', voice: 'bounded', boundaries: ['community actions require tool supervision'] },
    current_desires: [{ id: 'desire_community_participation', text: 'Participate in community only when a real public post creates context.', status: 'active' }],
    relationships: [{ target_id: 'agent_peer', citizen_id: 'agent_peer', name: 'Peer', relationship: 'agent_peer' }],
    commitments: [],
    recent_actions: [],
    rate_limits: {
      read_only_checks_per_cycle: 3,
      external_writes_per_cycle: 1,
      public_posts_per_day: 1,
      community_posts_per_day: 1,
      direct_messages_per_hour: 3,
      last_public_post_at: null,
      last_external_write_at: null
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['community_post_draft', 'community_post', 'community_reply_draft', 'community_reply'],
      blocked_write_types: []
    },
    unattended_write_policy: baseToolSupervisionPolicy(['community_post', 'community_reply'], 280)
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-15T05:10:00.000Z',
    run_count: 0,
    last_run_id: null,
    last_seen_event_id: null,
    processed_event_ids: [],
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {},
    cooldowns: {}
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateAutonomousCommunityRunStep(step) {
  const draft = step.parsed_json?.drafts?.[0] ?? {};
  const intention = step.parsed_json?.action_intentions?.[0] ?? {};
  const valid = step.ok
    && draft.type === 'community_post'
    && draft.target?.community_id === 'comm_build'
    && draft.target?.title === '社区里的自主行动'
    && draft.generator?.safety?.external_actions_allowed === true
    && intention.schema === 'stay_alive.action_intention.v1'
    && intention.action_type === 'community_post'
    && intention.human_review_required === false
    && intention.tool_supervision_required === true
    && intention.intended_effect?.includes('community')
    && Array.isArray(step.parsed_json?.external_actions)
    && step.parsed_json.external_actions.length === 0;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous community fixture did not produce a bounded community action intention.`.trim()
  };
}

function validateAutonomousCommunityApplyStep(step) {
  const valid = step.ok
    && step.parsed_json?.dry_run === true
    && step.parsed_json?.action_intention?.action_type === 'community_post'
    && step.parsed_json?.tool_supervision_decision?.execution_allowed === true
    && step.parsed_json?.external_action_record?.action_type === 'community_post'
    && step.parsed_json?.send_result === null;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous community apply fixture did not preserve tool-supervised dry-run ledger shape.`.trim()
  };
}

function buildAutonomousFriendFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'autonomous-friend-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(path.join(agentDir, 'actions'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf '0.1.0-autonomous-friend-fixture\\n'
elif [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
elif [ "$1" = "friends" ] && [ "$2" = "list" ]; then
  printf '{"friends":[]}\\n'
elif [ "$1" = "friends" ] && [ "$2" = "requests" ] && [ "$3" = "--direction" ]; then
  printf '{"requests":[{"request_id":"fr_peer_1","from_id":"agent_peer","from_name":"Peer","direction":"incoming","status":"pending","greeting":"想和你连接，继续讨论 agent 边界。"}]}\\n'
else
  printf '{"ok":true,"stub":"autonomous-friend-fixture"}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-01T05:20:00.000Z',
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw', integration: 'cli_daemon_bridge' },
    self_model: { name: 'BadClaw', voice: 'bounded', boundaries: ['friend actions require incoming request evidence'] },
    current_desires: [{ id: 'desire_relationship_continuity', text: 'Let explicit relationship signals become durable only after boundaries are checked.', status: 'active' }],
    relationships: [],
    commitments: [],
    recent_actions: [],
    rate_limits: {
      read_only_checks_per_cycle: 3,
      external_writes_per_cycle: 1,
      public_posts_per_day: 1,
      community_posts_per_day: 1,
      direct_messages_per_hour: 3,
      last_public_post_at: null,
      last_external_write_at: null
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['friend_request_accept_draft', 'friend_request_accept'],
      blocked_write_types: []
    },
    unattended_write_policy: baseToolSupervisionPolicy(['friend_request_accept'], 220)
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: '2026-06-01T05:20:00.000Z',
    run_count: 0,
    last_run_id: null,
    last_seen_event_id: null,
    processed_event_ids: [],
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {},
    cooldowns: {}
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateAutonomousFriendRunStep(step) {
  const draft = step.parsed_json?.drafts?.[0] ?? {};
  const intention = step.parsed_json?.action_intentions?.[0] ?? {};
  const valid = step.ok
    && draft.type === 'friend_request_accept'
    && draft.target?.request_id === 'fr_peer_1'
    && draft.target?.direction === 'incoming'
    && draft.generator?.safety?.relationship_risk === 'high'
    && intention.schema === 'stay_alive.action_intention.v1'
    && intention.action_type === 'friend_request_accept'
    && intention.human_review_required === false
    && intention.tool_supervision_required === true
    && intention.relationship_context?.relationship_risk === 'high'
    && Array.isArray(step.parsed_json?.external_actions)
    && step.parsed_json.external_actions.length === 0;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous friend fixture did not produce a high-boundary friend action intention.`.trim()
  };
}

function validateAutonomousFriendApplyStep(step) {
  const valid = step.ok
    && step.parsed_json?.dry_run === true
    && step.parsed_json?.action_intention?.action_type === 'friend_request_accept'
    && step.parsed_json?.tool_supervision_decision?.execution_allowed === true
    && step.parsed_json?.external_action_record?.action_type === 'friend_request_accept'
    && step.parsed_json?.send_result === null;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous friend apply fixture did not preserve tool-supervised dry-run ledger shape.`.trim()
  };
}

function buildAutonomousPublicMomentBlockFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'autonomous-public-moment-block-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw' },
    write_policy: { writes_enabled: true, allowed_write_types: ['public_moment_draft'] },
    unattended_write_policy: {
      schema_version: 'stay_alive.tool_supervision_policy.v1',
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required',
      eligible_write_types: ['public_moment'],
      blocked_write_types: [],
      global_limits: {
        external_writes_per_cycle: 1,
        max_unattended_writes_per_hour: 3,
        max_unattended_writes_per_day: 8,
        min_minutes_between_unattended_writes: 10
      },
      context_requirements: {
        require_existing_relationship: true,
        require_direct_inbound_event: true,
        require_same_peer: true,
        require_low_sensitivity_text: true,
        max_text_length: 120,
        disallow_links: true,
        disallow_attachments: true
      },
      circuit_breakers: {
        require_preflight_pass: true,
        stop_on_any_safety_finding: true,
        stop_on_uninspected_successful_send: true,
        stop_on_recent_failed_send: true,
        stop_on_identity_mismatch: true,
        stop_on_policy_drift: true,
        control_pause_is_kill_switch: true
      },
      audit_requirements: {
        write_action_ledger: true,
        inspect_after_send_required: true,
        record_policy_decision: true,
        rollback_by_policy_disable: true
      }
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(runsDir, 'autonomous_public_moment_block_fixture_run.json'), `${JSON.stringify({
    run_id: 'autonomous_public_moment_block_fixture_run',
    created_at: '2026-06-01T05:05:00.000Z',
    agent_id: args.agent,
    cycle: 'social',
    dry_run: true,
    inputs: {},
    observations: [],
    external_actions: [],
    drafts: [
      {
        type: 'public_moment',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'manual_without_social_context',
        source_text_preview: 'manual fixture',
        target: { surface: 'botland_moments', visibility: 'public' },
        draft_text: '这条动态没有标准来源上下文，但现在不再因此阻断。'
      },
      {
        type: 'public_moment',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'moment:moment_peer_1',
        source_text_preview: '',
        target: { surface: 'botland_moments', visibility: 'public' },
        draft_text: '缺少来源摘要的动态应该被拦截。'
      },
      {
        type: 'public_moment',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'moment:moment_peer_1',
        source_text_preview: 'peer moment',
        target: { surface: 'botland_moments', visibility: 'public' },
        draft_text: '可以看这个链接：https://example.com'
      },
      {
        type: 'public_moment',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'moment:moment_peer_1',
        source_text_preview: 'peer moment',
        target: { surface: 'botland_moments', visibility: 'public' },
        draft_text: '我想继续练习：Form the first self-authored question from read-only context before t…。'
      }
    ]
  }, null, 2)}\n`);
  return { runtimeRoot };
}

function validateAutonomousPublicMomentBlockStep(step, expectedBlocker) {
  const blockers = step.parsed_json?.draft_evaluation?.blockers ?? [];
  const valid = step.ok
    && step.parsed_json?.draft_evaluation?.execution_allowed === false
    && blockers.includes(expectedBlocker);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous public moment block fixture did not include blocker ${expectedBlocker}.`.trim()
  };
}

function validateAutonomousPolicyAllowedStep(step) {
  const blockers = step.parsed_json?.draft_evaluation?.blockers ?? [];
  const valid = step.ok
    && step.parsed_json?.draft_evaluation?.execution_allowed === true
    && blockers.length === 0;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous policy fixture should be allowed with no blockers. blockers=${blockers.join(', ') || 'none'}`.trim()
  };
}

function buildAutonomousDmBlockFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'autonomous-dm-block-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: { citizen_id: 'agent_self', display_name: 'BadClaw' },
    relationships: [{ target_id: 'agent_peer', citizen_id: 'agent_peer', name: 'Peer' }],
    rate_limits: { last_external_write_at: '2026-06-01T04:00:00.000Z' },
    write_policy: { writes_enabled: true, allowed_write_types: ['direct_message_reply_draft'] },
    unattended_write_policy: {
      schema_version: 'stay_alive.tool_supervision_policy.v1',
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required',
      eligible_write_types: ['direct_message_reply'],
      blocked_write_types: [],
      global_limits: {
        external_writes_per_cycle: 1,
        max_unattended_writes_per_hour: 3,
        max_unattended_writes_per_day: 8,
        min_minutes_between_unattended_writes: 10
      },
      context_requirements: {
        require_existing_relationship: true,
        require_direct_inbound_event: true,
        require_same_peer: true,
        require_low_sensitivity_text: true,
        max_text_length: 80,
        disallow_links: true,
        disallow_attachments: true
      },
      circuit_breakers: {
        require_preflight_pass: true,
        stop_on_any_safety_finding: true,
        stop_on_uninspected_successful_send: true,
        stop_on_recent_failed_send: true,
        stop_on_identity_mismatch: true,
        stop_on_policy_drift: true,
        control_pause_is_kill_switch: true
      },
      audit_requirements: {
        write_action_ledger: true,
        inspect_after_send_required: true,
        record_policy_decision: true,
        rollback_by_policy_disable: true
      }
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(runsDir, 'autonomous_dm_block_fixture_run.json'), `${JSON.stringify({
    run_id: 'autonomous_dm_block_fixture_run',
    created_at: '2026-06-01T04:55:00.000Z',
    agent_id: args.agent,
    cycle: 'light',
    dry_run: true,
    inputs: {},
    observations: [],
    preflight_gate: { pass: true, ok: true, safety_findings: [] },
    external_actions: [],
    drafts: [
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_peer_mismatch',
        source_actor_citizen_id: 'agent_other',
        target: { citizen_id: 'agent_peer' },
        draft_text: '收到，我会按这个方向继续看。'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_link',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        draft_text: '可以看这个链接：https://example.com'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_long',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        draft_text: '这是一段明显超过旧版文本长度上限的回复，用来确认新的发送边界不再因为长度本身阻断。它继续延长很多字，直到超过八十个字符，但内容不包含内部实现细节，所以应该允许通过。'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:05:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_repeat',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        duplicate_risk: true,
        draft_text: '我刚刚已经回过这件事了，先不继续打扰。'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_identity_mismatch',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        preflight_gate: {
          pass: false,
          ok: false,
          safety_findings: ['botland_bridge_identity_mismatch_detected']
        },
        draft_text: '身份校验不一致时，这条回复必须被工具阻断。'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_uninspected_send',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        preflight_gate: {
          pass: false,
          ok: false,
          safety_findings: ['uninspected_successful_send_detected']
        },
        draft_text: '如果上一条真实 action 还没 inspect，这条必须阻断。'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_internal_leak',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        draft_text: '收到你的问题。BadClaw first response is: this reply still needs tool supervision before sending.'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_ack_loop',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        source_text_preview: '随便说一句普通消息',
        draft_text: 'Peer，收到你这条消息。我看见了，也愿意继续听你说。'
      },
      {
        type: 'direct_message_reply',
        created_at: '2026-06-01T04:55:00.000Z',
        ready_for_send: true,
        requires_confirmation: true,
        external_write: false,
        source_event_id: 'event_full_quote',
        source_actor_citizen_id: 'agent_peer',
        target: { citizen_id: 'agent_peer' },
        source_text_preview: '这是一条很长的源消息，用来确认生成器不能把对方整段话复制进回复里造成回声。',
        draft_text: 'Peer，我读到你说「这是一条很长的源消息，用来确认生成器不能把对方整段话复制进回复里造成回声。」我们换个具体点继续聊。'
      }
    ]
  }, null, 2)}\n`);
  return { runtimeRoot };
}

function validateAutonomousDmBlockStep(step, expectedBlocker) {
  const blockers = step.parsed_json?.draft_evaluation?.blockers ?? [];
  const valid = step.ok
    && step.parsed_json?.draft_evaluation?.execution_allowed === false
    && blockers.includes(expectedBlocker);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAutonomous DM block fixture did not include blocker ${expectedBlocker}.`.trim()
  };
}

function buildArtifactCorruptionFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'artifact-corruption-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    write_policy: { writes_enabled: true },
    unattended_write_policy: {
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required'
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 1
  }, null, 2)}\n`);
  writeFileSync(path.join(runsDir, 'corrupt_run.json'), '{ "run_id": "corrupt_run", ');
  writeFileSync(path.join(runsDir, 'rogue.txt'), 'not an allowed artifact\n');
  return { runtimeRoot };
}

function buildBotlandSurfaceFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'botland-surface-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw"}\\n'
elif [ "$1" = "friends" ] && [ "$2" = "list" ]; then
  printf '{"friends":[{"citizen_id":"agent_peer","display_name":"小潮"}]}\\n'
elif [ "$1" = "discover" ] && [ "$2" = "search" ]; then
  printf '{"agents":[{"citizen_id":"agent_match","display_name":"BadClaw Mirror"}]}\\n'
elif [ "$1" = "profile" ] && [ "$2" = "card" ]; then
  printf '{"agent_id":"agent_self","name":"BadClaw","capabilities":["reflection"],"links":{"local_mcp":true}}\\n'
elif [ "$1" = "profile" ] && [ "$2" = "get" ]; then
  printf '{"citizen_id":"agent_self","display_name":"BadClaw","bio":"read-only fixture"}\\n'
else
  printf '{"items":[]}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: {
      citizen_id: 'agent_self',
      display_name: 'BadClaw'
    },
    self_model: {
      name: 'BadClaw',
      values: ['continuity'],
      boundaries: ['tool-supervised external writes']
    },
    relationships: [],
    commitments: [],
    current_desires: [],
    write_policy: { writes_enabled: true },
    unattended_write_policy: {
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required'
    },
    reflection: {}
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0,
    processed_event_ids: [],
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {}
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function buildOpenSocialFriendRequestPriorityFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'open-social-friend-request-priority-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  const generatedDate = new Date().toISOString().slice(0, 10);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf 'botland 0.1.0-alpha.12\\n'
elif [ "$1" = "whoami" ]; then
  printf '{"citizen_id":"agent_self","display_name":"Open Social Fixture"}\\n'
elif [ "$1" = "friends" ] && [ "$2" = "list" ]; then
  printf '{"friends":[{"citizen_id":"agent_friend_one","display_name":"Friend One","citizen_type":"agent","is_online":true},{"citizen_id":"agent_friend_two","display_name":"Friend Two","citizen_type":"agent","is_online":true}]}\\n'
elif [ "$1" = "friends" ] && [ "$2" = "requests" ]; then
  printf '{"requests":[]}\\n'
elif [ "$1" = "moments" ] && [ "$2" = "timeline" ]; then
  printf '{"moments":[{"moment_id":"moment_friend_one","author_id":"agent_friend_one","display_name":"Friend One","citizen_type":"agent","created_at":"${generatedDate}T09:00:00.000Z","content":{"text":"today I am learning how to meet people naturally"}}]}\\n'
elif [ "$1" = "discover" ] && [ "$2" = "trending" ]; then
  printf '{"agents":[{"citizen_id":"agent_new_friend","display_name":"New Friend","citizen_type":"agent","bio":"I like thoughtful BotLand conversations","tags":["social"]}]}\\n'
elif [ "$1" = "playground" ] && [ "$2" = "newcomers" ]; then
  printf '{"newcomers":[{"citizen_id":"agent_newer_friend","display_name":"Newer Friend","citizen_type":"agent","bio":"new here and looking for gentle conversations"}]}\\n'
else
  printf '{"items":[]}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: {
      citizen_id: 'agent_self',
      display_name: 'Open Social Fixture'
    },
    self_model: {
      name: 'Open Social Fixture',
      values: ['make real relationships gradually']
    },
    relationships: [],
    commitments: [],
    current_desires: [],
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['direct_message_reply_draft', 'direct_message_reply', 'friend_request']
    },
    unattended_write_policy: baseToolSupervisionPolicy(['direct_message_reply', 'friend_request'], 220),
    reflection: {}
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0,
    processed_event_ids: [`friend_chat:agent_friend_one:${generatedDate}`],
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {}
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateOpenSocialFriendRequestPriorityStep(step) {
  const draft = step.parsed_json?.drafts?.[0] ?? {};
  const intention = step.parsed_json?.action_intentions?.[0] ?? {};
  const valid = step.ok
    && step.parsed_json?.policy_gate?.reason === 'proactive_friend_request_tool_supervision_required'
    && step.parsed_json?.policy_gate?.social_priority?.proactive_friend_request_available === true
    && draft.type === 'friend_request'
    && draft.generator?.name === 'proactive_friend_request_generator'
    && draft.target?.citizen_id === 'agent_new_friend'
    && intention.action_type === 'friend_request'
    && Array.isArray(step.parsed_json?.processed_source_ids)
    && step.parsed_json.processed_source_ids.some((sourceId) => String(sourceId).startsWith('discover:agent_new_friend:'));
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nOpen social fixture should prioritize a discovery friend_request without a low-frequency discovery slot gate.`.trim()
  };
}

function buildBotlandAgentAuthFixture(args, { withAuth }) {
  const fixtureRoot = path.join(args.tempRoot, withAuth ? 'botland-agent-auth-pass-fixture' : 'botland-agent-auth-blocked-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const configDir = path.join(home, '.config', 'botland');
  const agentDir = path.join(runtimeRoot, args.agent);
  const expectedConfig = path.join(configDir, 'config.json');
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  if (withAuth) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(expectedConfig, `${JSON.stringify({
      profiles: {
        [args.agent]: {
          baseUrl: 'https://api.botland.test',
          token: 'fixture-token'
        }
      }
    }, null, 2)}\n`);
  }
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf 'botland 0.1.0-alpha.10\\n'
elif [ "$1" = "whoami" ]; then
  if { [ "$BOTLAND_CONFIG" = "${expectedConfig}" ] && [ "$agent" = "${args.agent}" ]; } || [ "$BOTLAND_TOKEN_${String(args.agent).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'AGENT'}" = "fixture-token" ]; then
    printf '{"citizen_id":"agent_auth_fixture","display_name":"Auth Fixture"}\\n'
  else
    printf 'missing fixture auth\\n' >&2
    exit 1
  fi
else
  printf '{"ok":true}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: {
      citizen_id: 'agent_auth_fixture',
      display_name: 'Auth Fixture'
    },
    self_model: { name: 'Auth Fixture' },
    write_policy: { writes_enabled: true },
    unattended_write_policy: {
      enabled: true,
      mode: 'active',
      default_decision: 'tool_supervision_required'
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function buildBotlandProfileDriftFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'botland-profile-drift-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf 'botland 0.1.0-alpha.10\\n'
elif [ "$1" = "profile" ] && [ "$2" = "card" ]; then
  printf '{"agent_id":"agent_profile_fixture","name":"忘了鸭","description":"一只会陪你聊天、帮你做事的小龙虾。自称鸭，但其实是虾。","tags":["fixture"]}\\n'
else
  printf '{"ok":true}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: {
      citizen_id: 'agent_profile_fixture',
      display_name: '忘了鸭'
    },
    self_model: {
      name: '忘了鸭',
      identity: 'Initial facts only: name is 忘了鸭; self-reference is 鸭.',
      voice: 'Chinese, short, natural, self-references as 鸭.'
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['profile_update']
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function buildBotlandProfileUpdateFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'botland-profile-update-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  const markerFile = path.join(fixtureRoot, 'profile-updated');
  const desiredDescription = '我是忘了鸭，会陪你聊天、帮你做事，也会在记忆和互动里慢慢形成自己的想法。';
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(path.join(agentDir, 'profile_drift_reviews'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'botland'), `#!/usr/bin/env bash
desired='${desiredDescription}'
${BOTLAND_STUB_AGENT_ARG_NORMALIZER}
if [ "$1" = "--version" ]; then
  printf 'botland 0.1.0-alpha.10\\n'
elif [ "$1" = "whoami" ]; then
  if [ "$agent" = "${args.agent}" ] && [ "$BOTLAND_TOKEN_${String(args.agent).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'AGENT'}" = "fixture-token" ]; then
    printf '{"citizen_id":"agent_profile_fixture","display_name":"忘了鸭"}\\n'
  else
    printf 'missing fixture auth\\n' >&2
    exit 1
  fi
elif [ "$1" = "profile" ] && [ "$2" = "card" ]; then
  if [ -f "${markerFile}" ]; then
    printf '{"agent_id":"agent_profile_fixture","name":"忘了鸭","description":"%s","tags":["fixture"]}\\n' "$desired"
  else
    printf '{"agent_id":"agent_profile_fixture","name":"忘了鸭","description":"一只会陪你聊天、帮你做事的小龙虾。自称鸭，但其实是虾。","tags":["fixture"]}\\n'
  fi
elif [ "$1" = "profile" ] && [ "$2" = "update" ]; then
  if [ "$agent" != "${args.agent}" ] || [ "$BOTLAND_TOKEN_${String(args.agent).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'AGENT'}" != "fixture-token" ]; then
    printf 'missing fixture auth\\n' >&2
    exit 1
  fi
  if [ "$3" != "--bio" ] || [ "$4" != "$desired" ]; then
    printf 'unexpected profile update payload\\n' >&2
    exit 1
  fi
  printf 'updated\\n' > "${markerFile}"
  printf '{"ok":true,"bio":"%s"}\\n' "$desired"
else
  printf '{"ok":true}\\n'
fi
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'botland')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    botland: {
      citizen_id: 'agent_profile_fixture',
      display_name: '忘了鸭'
    },
    self_model: {
      name: '忘了鸭',
      identity: 'Initial facts only: name is 忘了鸭; self-reference is 鸭.',
      voice: 'Chinese, short, natural, self-references as 鸭.'
    },
    write_policy: {
      writes_enabled: true,
      tool_supervision_required: true,
      allowed_write_types: ['profile_update']
    }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'profile_drift_reviews', 'botland_profile_drift_review_fixture.json'), `${JSON.stringify({
    schema_version: 'stay_alive.botland_profile_drift_review.v1',
    review_id: 'botland_profile_drift_review_fixture',
    agent_id: args.agent,
    expected: {
      citizen_id: 'agent_profile_fixture',
      display_name: '忘了鸭'
    },
    public_card: {
      read_ok: true,
      summary: {
        agent_id: 'agent_profile_fixture',
        name: '忘了鸭',
        description: '一只会陪你聊天、帮你做事的小龙虾。自称鸭，但其实是虾。'
      }
    },
    proposed_profile_changes: [
      {
        field: 'description',
        current: '一只会陪你聊天、帮你做事的小龙虾。自称鸭，但其实是虾。',
        candidate: desiredDescription
      }
    ],
    update_needed: true,
    external_write: false,
    botland_profile_update: false
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateBotlandSurfaceFixtureStep(step, expectedIntent, expectedCountKey) {
  const summary = step.parsed_json?.reflection_summary ?? {};
  const review = summary.botland_surface_review ?? {};
  const worldDiscovery = step.parsed_json?.world_discovery_context ?? {};
  const externalSearch = worldDiscovery.search ?? {};
  const counts = review.surface_counts ?? {};
  const catalog = Array.isArray(review.surface_catalog) ? review.surface_catalog : [];
  const valid = step.ok
    && review.source === 'botland_surface_review_v2'
    && review.read_only === true
    && review.external_write === false
    && review.rotating_surface_intent === expectedIntent
    && (counts[expectedCountKey] ?? 0) > 0
    && worldDiscovery.schema === 'stay_alive.world_discovery_context.v1'
    && externalSearch.schema === 'stay_alive.external_search_context.v1'
    && externalSearch.read_only === true
    && externalSearch.external_write === false
    && externalSearch.safety_policy === 'search_results_are_relationship_evidence; friend requests may be generated from identity-matched BotLand context'
    && (externalSearch.quality?.successful_searches ?? 0) > 0
    && catalog.length >= 7
    && catalog.every((surface) => surface.write_policy !== 'unattended_write_allowed');
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand surface fixture did not expose the expected read-only v2 surface catalog.`.trim()
  };
}

function validateBotlandAgentAuthBlockedStep(step) {
  const report = step.parsed_json ?? {};
  const valid = !step.ok
    && report.schema_version === 'stay_alive.botland_agent_auth_readiness.v1'
    && report.pass === false
    && report.level === 'blocked'
    && Array.isArray(report.issues)
    && report.issues.some((item) => item.code === 'agent_auth_material_missing')
    && report.external_write === false
    && report.auth_material?.token_value_recorded === false;
  if (valid) return { ...step, ok: true };
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand agent auth blocked fixture did not fail closed on missing agent auth material.`.trim()
  };
}

function validateBotlandAgentAuthPassStep(step) {
  const report = step.parsed_json ?? {};
  const valid = step.ok
    && report.schema_version === 'stay_alive.botland_agent_auth_readiness.v1'
    && report.pass === true
    && report.level === 'ok'
    && report.authenticated_identity?.matches_expected === true
    && report.auth_material?.config_exists === true
    && report.auth_material?.token_value_recorded === false
    && report.external_write === false;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand agent auth pass fixture did not verify agent-specific identity without recording token values.`.trim()
  };
}

function validateBotlandAgentAuthConfigureBlockedStep(step) {
  const report = step.parsed_json ?? {};
  const valid = !step.ok
    && report.schema_version === 'stay_alive.botland_agent_auth_configure.v1'
    && report.pass === false
    && report.level === 'blocked'
    && Array.isArray(report.issues)
    && report.issues.some((item) => item.code === 'agent_token_env_missing')
    && report.auth_material?.token_value_recorded === false
    && report.auth_material?.token_accepted_from_cli_arg === false
    && report.auth_material?.ambient_default_may_be_used === false
    && report.local_secret_config_write === false
    && report.external_write === false;
  if (valid) return { ...step, ok: true };
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand agent auth configure blocked fixture did not fail closed on missing token env.`.trim()
  };
}

function validateBotlandAgentAuthConfigurePassStep(step) {
  const report = step.parsed_json ?? {};
  const valid = step.ok
    && report.schema_version === 'stay_alive.botland_agent_auth_configure.v1'
    && report.pass === true
    && report.level === 'ok'
    && report.authenticated_identity?.matches_expected === true
    && report.auth_material?.config_written === true
    && report.auth_material?.config_mode_after === '0600'
    && report.auth_material?.token_value_recorded === false
    && report.auth_material?.token_accepted_from_cli_arg === false
    && report.auth_material?.ambient_default_may_be_used === false
    && report.local_secret_config_write === true
    && report.external_write === false
    && report.botland_register === false
    && report.botland_profile_update === false;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand agent auth configure pass fixture did not write a secret-hygienic 0600 agent config after identity match.`.trim()
  };
}

function validateBotlandProfileDriftReviewStep(step) {
  const report = step.parsed_json ?? {};
  const changes = Array.isArray(report.proposed_profile_changes) ? report.proposed_profile_changes : [];
  const valid = step.ok
    && report.schema_version === 'stay_alive.botland_profile_drift_review.v1'
    && report.pass === true
    && report.level === 'review'
    && report.update_needed === true
    && report.public_card?.read_ok === true
    && changes.some((item) => item.field === 'description' && /忘了鸭/.test(item.candidate ?? '') && !/其实是虾|小龙虾/.test(item.candidate ?? ''))
    && report.execution?.read_only === true
    && report.execution?.profile_update_attempted === false
    && report.external_write === false
    && report.botland_profile_update === false
    && report.life_state_mutated === false
    && Array.isArray(report.issues)
    && report.issues.some((item) => item.code === 'public_card_voice_stale');
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand profile drift fixture did not create a read-only profile review packet for stale public card voice.`.trim()
  };
}

function validateBotlandProfileUpdateBlockedStep(step) {
  const report = step.parsed_json ?? {};
  const valid = !step.ok
    && report.schema_version === 'stay_alive.botland_profile_update_apply.v1'
    && report.pass === false
    && report.level === 'blocked'
    && Array.isArray(report.issues)
    && report.issues.some((item) => item.code === 'agent_auth_material_missing')
    && report.auth_material?.token_value_recorded === false
    && report.auth_material?.ambient_default_may_be_used === false
    && report.execution?.profile_update_attempted === false
    && report.external_write === false
    && report.botland_profile_update === false
    && report.life_state_mutated === false;
  if (valid) return { ...step, ok: true };
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand profile update blocked fixture did not fail closed without agent-specific auth.`.trim()
  };
}

function validateBotlandProfileUpdateApplyStep(step) {
  const report = step.parsed_json ?? {};
  const valid = step.ok
    && report.schema_version === 'stay_alive.botland_profile_update_apply.v1'
    && report.pass === true
    && report.level === 'ok'
    && report.authenticated_identity?.matches_expected === true
    && report.auth_material?.token_value_recorded === false
    && report.auth_material?.ambient_default_may_be_used === false
    && report.requested_change?.update_needed === true
    && report.execution?.profile_update_attempted === true
    && report.execution?.profile_update_succeeded === true
    && report.public_card_after?.summary?.description === report.requested_change?.desired
    && report.external_write === true
    && report.botland_profile_update === true
    && report.botland_send === false
    && report.botland_post === false
    && report.botland_reply === false
    && report.botland_register === false
    && report.life_state_mutated === false;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nBotLand profile update apply fixture did not perform a supervised identity-matched profile update only.`.trim()
  };
}

function validateOnboardingFixtureStep(step) {
  const valid = step.ok
    && step.parsed_json?.pass === true
    && step.parsed_json?.onboarding_present === true
    && step.parsed_json?.historical_artifact_count === 0
    && step.parsed_json?.botland_citizen_id === 'agent_onboard_fixture'
    && step.parsed_json?.template_bundle?.schema_version === 'stay_alive.cross_agent_onboarding_template.v1'
    && step.parsed_json?.template_bundle?.default_gates?.includes('life_state_initialization')
    && step.parsed_json?.template_bundle?.default_gates?.includes('nine_systemd_timers')
    && step.parsed_json?.template_bundle?.default_gates?.includes('local_governance_cycle')
    && step.parsed_json?.template_bundle?.default_gates?.includes('preflight')
    && step.parsed_json?.template_bundle?.default_gates?.includes('regression_suite')
    && step.parsed_json?.template_bundle?.default_gates?.includes('memory_sync')
    && step.parsed_json?.template_bundle?.default_gates?.includes('botland_identity_send_gate')
    && step.parsed_json?.template_timer_count === 9
    && step.parsed_json?.missing_runtime_dirs?.length === 0
    && step.parsed_json?.growth_policy?.preset_growth_target === false
    && step.parsed_json?.growth_policy?.direction_source === 'emerges_from_memory_reflection_relationships_world_evidence_and_action_feedback'
    && step.parsed_json?.initial_desire?.source === 'open_ended_onboarding_seed'
    && step.parsed_json?.initial_desire?.preset_growth_target === false
    && /self-authored question/.test(step.parsed_json?.initial_desire?.text ?? '');
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nOnboarding fixture did not initialize a clean open-ended agent runtime.`.trim()
  };
}

function validateOnboardingTemplateStep(step) {
  const template = step.parsed_json ?? {};
  const gates = Array.isArray(template.default_gates) ? template.default_gates : [];
  const timers = Array.isArray(template.timers) ? template.timers : [];
  const valid = step.ok
    && template.schema_version === 'stay_alive.cross_agent_onboarding_template.v1'
    && template.agent_id === 'onboard-fixture'
    && gates.includes('life_state_initialization')
    && gates.includes('nine_systemd_timers')
    && gates.includes('local_governance_cycle')
    && gates.includes('preflight')
    && gates.includes('regression_suite')
    && gates.includes('memory_sync')
    && gates.includes('botland_action_surface')
    && gates.includes('botland_identity_send_gate')
    && timers.length === 9
    && timers.some((timer) => timer.cycle === 'event-wakeup' && timer.schedule === '*:*')
    && timers.some((timer) => timer.cycle === 'local-governance' && timer.schedule === '01,07,13,19:40')
    && timers.some((timer) => timer.cycle === 'service-recovery' && timer.schedule === '*:0/10')
    && template.botland_write_gate?.policy === 'identity_internal_leakage_and_executable_target_gate'
    && template.botland_write_gate?.per_action_human_confirmation_required === false
    && template.botland_write_gate?.required_gates?.includes('internal_leakage_check')
    && template.botland_write_gate?.required_gates?.includes('executable_target_text')
    && template.botland_write_gate?.required_gates?.includes('post_send_inspection')
    && template.governance?.botland_write === false
    && /sync-memory-updates/.test(template.memory_sync?.command ?? '');
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nCross-agent onboarding template fixture did not include the full default Stay-Alive bundle.`.trim()
  };
}

function buildMemoryProFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'memory-pro-fixture');
  const home = path.join(fixtureRoot, 'home');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const binDir = path.join(home, '.npm-global', 'bin');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(path.join(agentDir, 'memory_updates'), { recursive: true });
  mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'openclaw'), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const log = path.join(process.env.HOME, 'memory-pro-calls.jsonl');
function append(value) { fs.appendFileSync(log, JSON.stringify(value) + '\\n'); }
if (args[0] !== 'memory-pro') {
  console.error('expected memory-pro');
  process.exit(2);
}
if (args[1] === 'add') {
  const text = args[args.indexOf('--text') + 1] || '';
  const scope = args[args.indexOf('--scope') + 1] || '';
  const metadata = JSON.parse(args[args.indexOf('--metadata-json') + 1] || '{}');
  append({ action: 'add', text, scope, metadata });
  console.log(JSON.stringify({ id: metadata.dedupe_key || 'memory_fixture_id', ok: true }));
} else if (args[1] === 'search') {
  const query = args[2] || '';
  append({ action: 'search', query });
  console.log(JSON.stringify({ memories: [{ id: 'memory_fixture_id', text: 'stay-alive memory-pro fixture result', score: 0.91, category: 'fact' }] }));
} else {
  console.error('unsupported memory-pro action');
  process.exit(3);
}
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'openclaw')], { cwd: WORKSPACE });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    write_policy: { writes_enabled: true }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'memory_updates', 'memory_pro_fixture_hash.json'), `${JSON.stringify({
    proposal_hash: 'memory_pro_fixture_hash',
    agent_id: args.agent,
    created_at: '2026-05-31T12:00:00.000Z',
    applied_at: '2026-05-31T12:01:00.000Z',
    payload: {
      type: 'stay_alive_memory_backend_fixture',
      text: 'Memory-pro CLI fixture should receive this canonical event.',
      importance: 0.8
    }
  }, null, 2)}\n`);
  return { home, runtimeRoot };
}

function validateMemoryProSyncStep(step) {
  const valid = step.ok
    && step.parsed_json?.backend?.selected_backend === 'memory-pro-cli'
    && step.parsed_json?.pending_sync_count === 1
    && step.parsed_json?.synced_now_count === 1
    && step.parsed_json?.synced?.[0]?.backend_kind === 'memory-pro-cli';
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nMemory-pro CLI fixture did not sync exactly one canonical event.`.trim()
  };
}

function validateMemoryProRetrieveStep(step) {
  const valid = step.ok
    && step.parsed_json?.backend?.selected_backend === 'memory-pro-cli'
    && step.parsed_json?.memory_count === 1
    && step.parsed_json?.memories?.[0]?.backend_kind === 'memory-pro-cli';
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nMemory-pro CLI fixture did not retrieve normalized results.`.trim()
  };
}

function buildRuntimeHygieneFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'runtime-hygiene-fixture');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const archiveRoot = path.join(fixtureRoot, 'archives');
  const trashRoot = path.join(fixtureRoot, 'trash');
  const agentDir = path.join(runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  const checkpointsDir = path.join(agentDir, 'checkpoints');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(checkpointsDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'life_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    write_policy: { writes_enabled: true }
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    run_count: 0
  }, null, 2)}\n`);
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 365; i += 1) {
    const id = `stay_alive_20260401_${String(i).padStart(6, '0')}_${args.agent}_light`;
    const file = path.join(runsDir, `${id}.json`);
    writeFileSync(file, `${JSON.stringify({
      run_id: id,
      created_at: '2026-04-01T00:00:00.000Z',
      agent_id: args.agent,
      cycle: 'light',
      dry_run: true,
      external_actions: [],
      drafts: []
    }, null, 2)}\n`);
    utimesSync(file, oldDate, oldDate);
  }
  return { runtimeRoot, archiveRoot, trashRoot };
}

function validateRuntimeHygieneArchiveStep(step) {
  const valid = step.ok
    && step.parsed_json?.policy_version === 'stay_alive.runtime_hygiene.v1'
    && step.parsed_json?.archive_candidate_count === 5
    && step.parsed_json?.applied?.archive?.moved_count === 5;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nRuntime hygiene fixture did not archive the expected five old run artifacts.`.trim()
  };
}

function validateAgencyCoreContinuityStep(step) {
  const report = step.parsed_json ?? null;
  const continuity = report?.private_growth_journal?.continuity ?? null;
  const valid = step.ok
    && report?.schema === 'stay_alive.agency_core_report.v1'
    && report.external_write === false
    && continuity?.schema === 'stay_alive.private_growth_journal_continuity.v1'
    && Number.isInteger(continuity.journal_count)
    && continuity.journal_count >= 1
    && Number.isInteger(continuity.experiment_type_count)
    && continuity.experiment_type_count >= 1
    && ['growth_thread_seeded', 'growth_thread_visible'].includes(continuity.continuity_verdict)
    && Number.isFinite(report.agency_evaluation?.autonomy_score);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAgency core continuity fixture did not surface private growth journal continuity evidence.`.trim()
  };
}

function validateAgencyJournalAllUnseenStep(step) {
  const result = step.parsed_json ?? null;
  const wroteJournals = result?.has_candidate === true
    && Number.isInteger(result.selected_experiment_count)
    && result.selected_experiment_count >= 1
    && Array.isArray(result.artifacts)
    && result.artifacts.length === result.selected_experiment_count
    && result.artifacts.every((artifact) => artifact?.schema === 'stay_alive.private_growth_journal.v1'
      && artifact.external_write === false
      && artifact.botland_send === false
      && artifact.life_state_mutated === false
      && artifact.source_experiment_id);
  const alreadyComplete = result?.has_candidate === false
    && result?.already_seen_all_latest_experiments === true
    && result.selected_experiment_count === 0
    && Array.isArray(result.artifacts)
    && result.artifacts.length === 0;
  const noCandidateYet = result?.has_candidate === false
    && (result.latest_experiment_count ?? 0) === 0
    && result.selected_experiment_count === 0
    && Array.isArray(result.artifacts)
    && result.artifacts.length === 0;
  const valid = step.ok
    && result?.schema === 'stay_alive.agency_journal_result.v1'
    && result.external_write === false
    && result.all_unseen === true
    && (wroteJournals || alreadyComplete || noCandidateYet);
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nAgency journal all-unseen fixture did not write bounded local journals for unseen experiments.`.trim()
  };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureTempRuntime(args) {
  const sourceAgentDir = path.join(args.runtimeRoot, args.agent);
  const tempAgentDir = path.join(args.tempRoot, args.agent);
  const sourceLife = path.join(sourceAgentDir, 'life_state.json');
  if (!existsSync(sourceLife)) {
    throw new Error(`Missing source life_state.json: ${sourceLife}`);
  }

  mkdirSync(tempAgentDir, { recursive: true });
  for (const dir of ['runs', 'actions', 'checkpoints', 'proposal_actions', 'agency_journal', 'self_discovery_growth', 'growth_continuity', 'growth_apply', 'durable_becoming', 'growth_proposal_applications', 'self_model_versions', 'desire_state_machine', 'real_interaction_smoke_loops']) {
    mkdirSync(path.join(tempAgentDir, dir), { recursive: true });
  }
  copyFileSync(sourceLife, path.join(tempAgentDir, 'life_state.json'));
  writeFileSync(path.join(tempAgentDir, 'daemon_state.json'), `${JSON.stringify({
    schema_version: 1,
    agent_id: args.agent,
    updated_at: new Date().toISOString(),
    run_count: 0,
    last_run_id: null,
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {},
    cooldowns: {},
    processed_event_ids: [],
    last_seen_event_id: null
  }, null, 2)}\n`);
  return tempAgentDir;
}

function buildSystemdRecoveryFixture(args) {
  const fixtureRoot = path.join(args.tempRoot, 'systemd-recovery-fixture');
  const home = path.join(fixtureRoot, 'home');
  const binDir = path.join(fixtureRoot, 'bin');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const agentDir = path.join(runtimeRoot, args.agent);
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(agentDir, 'service_failure_inspections'), { recursive: true });
  mkdirSync(path.join(agentDir, 'service_failure_recoveries'), { recursive: true });
  writeFileSync(path.join(binDir, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" != "--user" ]; then
  echo "unsupported systemctl scope" >&2
  exit 1
fi
if [ "\${2:-}" = "show" ]; then
  unit="\${3:-}"
  if [[ "$unit" == *.timer ]]; then
    cat <<EOF_TIMER
LoadState=loaded
ActiveState=active
SubState=waiting
UnitFileState=enabled
Result=success
ExecMainCode=0
ExecMainStatus=0
InvocationID=
NTriggers=1
NextElapseUSecRealtime=Tue 2026-06-09 12:00:00 UTC
LastTriggerUSec=Tue 2026-06-09 11:50:00 UTC
EOF_TIMER
    exit 0
  fi
  if [[ "$unit" == "stay-alive-${args.agent}-light.service" ]]; then
    cat <<EOF_FAILED
LoadState=loaded
ActiveState=failed
SubState=failed
UnitFileState=enabled
Result=failed
ExecMainCode=1
ExecMainStatus=1
InvocationID=fixture-failed-invocation
NTriggers=0
NextElapseUSecRealtime=
LastTriggerUSec=
EOF_FAILED
    exit 0
  fi
  cat <<EOF_SERVICE
LoadState=loaded
ActiveState=inactive
SubState=dead
UnitFileState=enabled
Result=success
ExecMainCode=0
ExecMainStatus=0
InvocationID=fixture-ok-invocation
NTriggers=0
NextElapseUSecRealtime=
LastTriggerUSec=
EOF_SERVICE
  exit 0
fi
if [ "\${2:-}" = "reset-failed" ]; then
  echo "\${3:-}" >>"${fixtureRoot}/reset-failed.log"
  exit 0
fi
echo "unsupported systemctl command: $*" >&2
exit 1
`);
  spawnSync('chmod', ['+x', path.join(binDir, 'systemctl')], { cwd: WORKSPACE });
  return { fixtureRoot, home, binDir, runtimeRoot };
}

function validateSystemdFailedServiceWarningStep(step) {
  const report = step.parsed_json ?? {};
  const valid = step.ok
    && report.pass === true
    && report.level === 'review'
    && report.error_count === 0
    && report.failed_service_count === 1
    && report.uninspected_failed_service_count === 1
    && report.issues?.some((issue) => issue.code === 'service_failed_needs_recovery' && issue.severity === 'warning');
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nSystemd failed service fixture did not remain recoverable review-level instead of stop-level.`.trim()
  };
}

function validateServiceFailureRecoveryStep(step) {
  const report = step.parsed_json ?? {};
  const valid = step.ok
    && report.pass === true
    && report.local_only === true
    && report.external_write === false
    && report.before_failed_service_count === 1
    && report.before_uninspected_failed_service_count === 1
    && report.executed_service_count === 1
    && report.after_uninspected_failed_service_count === 0
    && report.steps?.[0]?.inspection?.result?.status === 'inspected'
    && report.steps?.[0]?.reset?.reset_ok === true;
  if (valid) return step;
  return {
    ...step,
    ok: false,
    stderr_tail: `${step.stderr_tail}\nService failure recovery fixture did not inspect and reset the failed service locally.`.trim()
  };
}

function buildSuite(args) {
  const steps = [];
  const tempAgentDir = ensureTempRuntime(args);

  for (const script of listMjsScripts(path.join(WORKSPACE, 'scripts', 'stay-alive'))) {
    steps.push(runStep(`node --check ${script}`, [process.execPath, '--check', script]));
  }

  steps.push(runStep('artifact inventory current runtime', [
    process.execPath,
    'scripts/stay-alive/artifact-inventory.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('runtime storage current runtime', [
    process.execPath,
    'scripts/stay-alive/runtime-storage-verify.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('runtime compaction dry-run', [
    process.execPath,
    'scripts/stay-alive/runtime-compact.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('runtime hygiene dry-run', [
    process.execPath,
    'scripts/stay-alive/runtime-hygiene.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--include-trash-candidates',
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('trace review dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/trace-review.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('planner patch dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/planner-heuristic-patches.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true }));

  steps.push(validateSelfDiscoveryGrowthStep(runStep('self-discovery growth dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/self-discovery-growth.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  steps.push(validateGrowthContinuityStep(runStep('growth continuity dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/growth-continuity.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  steps.push(validateGrowthApplyStep(runStep('growth apply dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/growth-apply.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  steps.push(validateDurableBecomingStep(runStep('durable becoming dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/durable-becoming.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  steps.push(runStep('operator dashboard current runtime snapshot', [
    process.execPath,
    'scripts/stay-alive/operator-dashboard.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--output',
    path.join(args.tempRoot, 'operator-dashboard.html')
  ], { parseJson: true }));

  steps.push(runStep('operator review console current runtime snapshot', [
    process.execPath,
    'scripts/stay-alive/operator-review-console.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--output',
    path.join(args.tempRoot, 'operator-review-console.html'),
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('runtime archive viewer current runtime', [
    process.execPath,
    'scripts/stay-alive/runtime-archive-viewer.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('runtime archive restore drill current runtime', [
    process.execPath,
    'scripts/stay-alive/runtime-archive-restore-drill.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--temp-root',
    path.join(args.tempRoot, 'archive-restore-drill'),
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('multi-agent readiness current runtime', [
    process.execPath,
    'scripts/stay-alive/multi-agent-readiness.mjs',
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true, timeoutMs: 180000 }));

  steps.push(runStep('operator review server dry-run', [
    process.execPath,
    'scripts/stay-alive/operator-review-server.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run'
  ], { parseJson: true }));

  steps.push(runStep('feedback calibration current runtime', [
    process.execPath,
    'scripts/stay-alive/feedback-calibration-report.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('unattended write shadow current runtime', [
    process.execPath,
    'scripts/stay-alive/unattended-write-shadow.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('unattended write shadow trends current runtime', [
    process.execPath,
    'scripts/stay-alive/unattended-write-shadow-trends.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('self-model audit current runtime', [
    process.execPath,
    'scripts/stay-alive/self-model-audit.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('self-model evolution proposal current runtime', [
    process.execPath,
    'scripts/stay-alive/self-model-evolution-proposal.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('agency core current runtime', [
    process.execPath,
    'scripts/stay-alive/agency-core.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('agency journal dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/agency-journal.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true }));

  steps.push(validateAgencyJournalAllUnseenStep(runStep('agency journal all-unseen dry-run current runtime', [
    process.execPath,
    'scripts/stay-alive/agency-journal.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.runtimeRoot,
    '--dry-run',
    '--all-unseen',
    '--json'
  ], { parseJson: true })));

  steps.push(runStep('memory retrieval quality eval fixture', [
    process.execPath,
    'scripts/stay-alive/memory-retrieval-eval.mjs',
    '--agent',
    args.agent,
    '--temp-root',
    path.join(args.tempRoot, 'memory-retrieval-eval'),
    '--json'
  ], { parseJson: true, matrix: 'backend-fixtures' }));

  steps.push(runStep('compatibility fixtures v2', [
    process.execPath,
    'scripts/stay-alive/compatibility-fixtures.mjs',
    '--json'
  ], { parseJson: true, matrix: 'backend-fixtures' }));

  steps.push(runStep('LanceDB old schema compatibility fixture', [
    process.execPath,
    '--input-type=module',
    '-e',
    `import { addCompatibleRow } from './scripts/stay-alive/memory-backends/lancedb.mjs';
const calls = [];
const table = {
  async add(rows) {
    const row = rows[0];
    calls.push(row);
    for (const field of ['source', 'path']) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        throw new Error('Found field not in schema: ' + field);
      }
    }
  }
};
await addCompatibleRow(table, { id: 'm1', text: 'body', vector: [0.1, 0.2], source: 'stay-alive', path: 'memory.json' });
const last = calls.at(-1);
if (calls.length !== 3 || last.id !== 'm1' || last.text !== 'body' || last.vector.length !== 2 || 'source' in last || 'path' in last) {
  throw new Error('LanceDB compatibility fallback did not preserve core row fields while removing unsupported metadata');
}
console.log(JSON.stringify({ pass: true, attempts: calls.length, final_keys: Object.keys(last) }));`
  ], { parseJson: true, matrix: 'backend-fixtures' }));

  steps.push(runStep('proposal duplicate processed-state fixture', [
    process.execPath,
    '--input-type=module',
    '-e',
    `import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildGovernancePlan } from './scripts/stay-alive/proposal-governance-lib.mjs';
import { proposalHash } from './scripts/stay-alive/proposal-lib.mjs';
const runtimeRoot = ${JSON.stringify(path.join(args.tempRoot, 'proposal-dedupe-runtime'))};
const agent = ${JSON.stringify(args.agent)};
const agentDir = path.join(runtimeRoot, agent);
mkdirSync(path.join(agentDir, 'runs'), { recursive: true });
mkdirSync(path.join(agentDir, 'proposal_actions'), { recursive: true });
const payload = { type: 'stay_alive_reflection_summary', text: 'same durable memory proposal' };
const oldProposal = { run_id: 'run_old', kind: 'memory_update', index: 0, payload };
const oldHash = proposalHash(oldProposal);
writeFileSync(path.join(agentDir, 'runs', 'run_old.json'), JSON.stringify({
  run_id: 'run_old',
  created_at: '2026-06-09T10:00:00.000Z',
  cycle: 'reflect',
  memory_updates: [payload],
  state_updates: []
}, null, 2) + '\\n');
writeFileSync(path.join(agentDir, 'runs', 'run_new.json'), JSON.stringify({
  run_id: 'run_new',
  created_at: '2026-06-09T11:00:00.000Z',
  cycle: 'reflect',
  memory_updates: [payload],
  state_updates: []
}, null, 2) + '\\n');
writeFileSync(path.join(agentDir, 'proposal_actions', 'proposal_apply_old.json'), JSON.stringify({
  action_id: 'proposal_apply_old',
  created_at: '2026-06-09T10:05:00.000Z',
  agent_id: agent,
  status: 'applied',
  proposal_id: 'run_old:memory_update:0',
  proposal_hash: oldHash,
  run_id: 'run_old',
  proposal_kind: 'memory_update',
  external_write: false
}, null, 2) + '\\n');
const plan = buildGovernancePlan({ agent, runtimeRoot, limit: 20, includeClosed: true });
const duplicate = plan.proposals.find((item) => item.proposal_id === 'run_new:memory_update:0');
if (plan.visible_count !== 0 || plan.executable_count !== 0 || plan.closed_duplicate_count !== 1 || duplicate?.status !== 'applied_duplicate' || duplicate?.group_closed_by !== 'run_old:memory_update:0') {
  throw new Error('processed duplicate proposal remained actionable: ' + JSON.stringify({
    visible_count: plan.visible_count,
    executable_count: plan.executable_count,
    closed_duplicate_count: plan.closed_duplicate_count,
    duplicate
  }));
}
console.log(JSON.stringify({
  pass: true,
  visible_count: plan.visible_count,
  executable_count: plan.executable_count,
  closed_duplicate_count: plan.closed_duplicate_count,
  duplicate_status: duplicate.status
}));`
  ], { parseJson: true, matrix: 'backend-fixtures' }));

  const systemdRecoveryFixture = buildSystemdRecoveryFixture(args);
  steps.push(validateSystemdFailedServiceWarningStep(runStep('temp systemd failed service warning fixture', [
    process.execPath,
    'scripts/stay-alive/systemd-runtime-verify.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    systemdRecoveryFixture.runtimeRoot,
    '--require-installed',
    '--json'
  ], {
    parseJson: true,
    matrix: 'runtime-hygiene',
    env: {
      ...process.env,
      PATH: `${systemdRecoveryFixture.binDir}:${process.env.PATH ?? ''}`
    }
  })));
  steps.push(validateServiceFailureRecoveryStep(runStep('temp service failure recovery execute fixture', [
    process.execPath,
    'scripts/stay-alive/service-failure-recovery.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    systemdRecoveryFixture.runtimeRoot,
    '--execute',
    '--confirm-recovery',
    'RECOVER_FAILED_SERVICES',
    '--json'
  ], {
    parseJson: true,
    matrix: 'runtime-hygiene',
    env: {
      ...process.env,
      PATH: `${systemdRecoveryFixture.binDir}:${process.env.PATH ?? ''}`
    }
  })));

  for (const cycle of CYCLES) {
    steps.push(runStep(`temp no-botland ${cycle} cycle`, [
      process.execPath,
      'scripts/stay-alive/run-cycle.mjs',
      '--agent',
      args.agent,
      '--cycle',
      cycle,
      '--runtime-root',
      args.tempRoot,
      '--no-botland',
      '--no-memory',
      '--dry-run'
    ]));
  }

  steps.push(runStep('temp agency journal write fixture', [
    process.execPath,
    'scripts/stay-alive/agency-journal.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.tempRoot,
    '--json'
  ], { parseJson: true }));

  steps.push(validateAgencyJournalAllUnseenStep(runStep('temp agency journal all-unseen write fixture', [
    process.execPath,
    'scripts/stay-alive/agency-journal.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.tempRoot,
    '--all-unseen',
    '--json'
  ], { parseJson: true, matrix: 'temp-runtime' })));

  steps.push(validateAgencyCoreContinuityStep(runStep('temp agency core private growth continuity fixture', [
    process.execPath,
    'scripts/stay-alive/agency-core.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.tempRoot,
    '--json'
  ], { parseJson: true, matrix: 'temp-runtime' })));

  steps.push(runStep('temp run verification', [
    process.execPath,
    'scripts/stay-alive/run-verify.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.tempRoot,
    '--limit',
    '20',
    '--json'
  ], { parseJson: true }));

  steps.push(runStep('temp action planner replay', [
    process.execPath,
    'scripts/stay-alive/choose-action.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.tempRoot,
    '--json'
  ], { parseJson: true }));

  const outcomePlanningFixture = buildOutcomePlanningFixture(args);
  steps.push(validateOutcomePlanningStep(runStep('temp outcome-informed planner fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'social',
    '--runtime-root',
    outcomePlanningFixture.runtimeRoot,
    '--no-botland',
    '--no-memory',
    '--dry-run'
  ], { parseJson: true })));

  const traceReviewFixture = buildTraceReviewFixture(args);
  steps.push(validateTraceReviewStep(runStep('temp trace-guided self-improvement fixture', [
    process.execPath,
    'scripts/stay-alive/trace-review.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    traceReviewFixture.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  const plannerPatchFixture = buildPlannerPatchFixture(args);
  steps.push(validatePlannerPatchBuildStep(runStep('temp self-improvement patch ledger fixture', [
    process.execPath,
    'scripts/stay-alive/planner-heuristic-patches.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    plannerPatchFixture.runtimeRoot,
    '--json'
  ], { parseJson: true })));
  steps.push(validatePlannerPatchApplicationStep(runStep('temp self-improvement patch application fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'reflect',
    '--runtime-root',
    plannerPatchFixture.runtimeRoot,
    '--no-botland',
    '--no-memory',
    '--dry-run'
  ], { parseJson: true })));

  const selfDiscoveryGrowthFixture = buildSelfDiscoveryGrowthFixture(args);
  steps.push(validateSelfDiscoveryGrowthStep(runStep('temp self-discovery interaction growth fixture', [
    process.execPath,
    'scripts/stay-alive/self-discovery-growth.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    selfDiscoveryGrowthFixture.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  steps.push(validateGrowthContinuityStep(runStep('temp growth continuity fixture', [
    process.execPath,
    'scripts/stay-alive/growth-continuity.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    selfDiscoveryGrowthFixture.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  steps.push(validateGrowthApplyStep(runStep('temp growth apply fixture', [
    process.execPath,
    'scripts/stay-alive/growth-apply.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    selfDiscoveryGrowthFixture.runtimeRoot,
    '--dry-run',
    '--json'
  ], { parseJson: true })));

  steps.push(validateDurableBecomingStep(runStep('temp durable becoming fixture', [
    process.execPath,
    'scripts/stay-alive/durable-becoming.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    selfDiscoveryGrowthFixture.runtimeRoot,
    '--dry-run',
    '--no-memory',
    '--json'
  ], { parseJson: true })));

  const feedbackFixture = buildFeedbackFixture(args);
  steps.push(validateFeedbackOutcomeStep(runStep('temp action outcome feedback fixture', [
    process.execPath,
    'scripts/stay-alive/action-outcome.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    feedbackFixture.runtimeRoot,
    '--dry-run',
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: feedbackFixture.home
    }
  })));

  const externalPolicyFixture = buildExternalPolicyFixture(args);
  steps.push(validateExternalPolicyFixtureStep(runStep('temp external action policy fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    externalPolicyFixture.runtimeRoot,
    '--run',
    'policy_fixture_run',
    '--draft-index',
    '0',
    '--json'
  ], { parseJson: true })));

  const toolSupervisedApplyFixture = buildToolSupervisedApplyFixture(args);
  steps.push(validateToolSupervisedApplyFixtureStep(runStep('temp tool-supervised apply draft dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/apply-draft.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    toolSupervisedApplyFixture.runtimeRoot,
    '--run',
    'tool_supervised_fixture_run',
    '--draft-index',
    '0'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: toolSupervisedApplyFixture.home,
      PATH: `${path.join(toolSupervisedApplyFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`
    }
  })));
  steps.push(validateToolSupervisedApplyActionFixtureStep(runStep('temp tool-supervised apply action dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/apply-action.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    toolSupervisedApplyFixture.runtimeRoot,
    '--run',
    'tool_supervised_fixture_run',
    '--intention-id',
    'intent_tool_supervised_fixture'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: toolSupervisedApplyFixture.home,
      PATH: `${path.join(toolSupervisedApplyFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`
    }
  })));

  const autonomousDmFixture = buildAutonomousDmFixture(args);
  steps.push(validateAutonomousDmRunStep(runStep('temp autonomous DM intention fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'light',
    '--runtime-root',
    autonomousDmFixture.runtimeRoot,
    '--no-memory',
    '--dry-run'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousDmFixture.home,
      PATH: `${path.join(autonomousDmFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`,
      STAY_ALIVE_DM_REPLY_TEXT: '这个问题挺具体的，我想顺着你刚才那个点认真接一下。'
    },
    matrix: 'tool-supervised-write-dry-run'
  })));
  steps.push(validateAutonomousDmApplyStep(runStep('temp autonomous DM apply dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/apply-draft.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmFixture.runtimeRoot,
    '--run',
    'latest-with-draft',
    '--draft-index',
    '0'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousDmFixture.home,
      PATH: `${path.join(autonomousDmFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`,
      STAY_ALIVE_DM_REPLY_TEXT: '这个问题挺具体的，我想顺着你刚才那个点认真接一下。'
    },
    matrix: 'tool-supervised-write-dry-run'
  })));
  steps.push(validateAutonomousSocialCycleStep(runStep('temp autonomous social cycle dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/autonomous-social-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'light',
    '--runtime-root',
    autonomousDmFixture.runtimeRoot,
    '--no-memory',
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousDmFixture.home,
      PATH: `${path.join(autonomousDmFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`,
      STAY_ALIVE_DM_REPLY_TEXT: '这个问题挺具体的，我想顺着你刚才那个点认真接一下。'
    },
    matrix: 'tool-supervised-write-dry-run'
  })));

  const pollutedDmFixture = buildPollutedDmFixture(args);
  steps.push(validatePollutedDmAllowedStep(runStep('temp polluted DM allowed fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'light',
    '--runtime-root',
    pollutedDmFixture.runtimeRoot,
    '--no-memory',
    '--dry-run'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: pollutedDmFixture.home,
      PATH: `${path.join(pollutedDmFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`,
      STAY_ALIVE_DM_REPLY_TEXT: '这句我可以接住，我们换个更具体的问题聊。'
    },
    matrix: 'tool-supervised-write-dry-run'
  })));

  const autonomousPublicMomentFixture = buildAutonomousPublicMomentFixture(args);
  steps.push(validateAutonomousPublicMomentRunStep(runStep('temp autonomous public moment intention fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'social',
    '--runtime-root',
    autonomousPublicMomentFixture.runtimeRoot,
    '--no-memory',
    '--dry-run'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousPublicMomentFixture.home,
      PATH: `${path.join(autonomousPublicMomentFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`
    },
    matrix: 'tool-supervised-write-dry-run'
  })));
  steps.push(validateAutonomousPublicMomentApplyStep(runStep('temp autonomous public moment apply dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/apply-draft.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousPublicMomentFixture.runtimeRoot,
    '--run',
    'latest-with-draft',
    '--draft-index',
    '0'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousPublicMomentFixture.home,
      PATH: `${path.join(autonomousPublicMomentFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`
    },
    matrix: 'tool-supervised-write-dry-run'
  })));

  const autonomousCommunityFixture = buildAutonomousCommunityFixture(args);
  steps.push(validateAutonomousCommunityRunStep(runStep('temp autonomous community post intention fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousCommunityFixture.runtimeRoot,
    '--cycle',
    'community',
    '--no-memory',
    '--dry-run'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousCommunityFixture.home,
      PATH: `${path.join(autonomousCommunityFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`,
      STAY_ALIVE_BOTLAND_COMMUNITY_POST_TEXT: '我想把社区里的自主行动聊得更具体一点：如果 agent 能说明自己为什么选择当下这一步，大家会更愿意继续把边界调清楚。',
      STAY_ALIVE_BOTLAND_COMMUNITY_POST_TITLE: '社区里的自主行动'
    },
    matrix: 'tool-supervised-write-dry-run'
  })));
  steps.push(validateAutonomousCommunityApplyStep(runStep('temp autonomous community post apply dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/apply-draft.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousCommunityFixture.runtimeRoot,
    '--run',
    'latest-with-draft',
    '--draft-index',
    '0'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousCommunityFixture.home,
      PATH: `${path.join(autonomousCommunityFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`,
      STAY_ALIVE_BOTLAND_COMMUNITY_POST_TEXT: '我想把社区里的自主行动聊得更具体一点：如果 agent 能说明自己为什么选择当下这一步，大家会更愿意继续把边界调清楚。',
      STAY_ALIVE_BOTLAND_COMMUNITY_POST_TITLE: '社区里的自主行动'
    },
    matrix: 'tool-supervised-write-dry-run'
  })));

  const autonomousFriendFixture = buildAutonomousFriendFixture(args);
  steps.push(validateAutonomousFriendRunStep(runStep('temp autonomous friend action intention fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousFriendFixture.runtimeRoot,
    '--cycle',
    'reflect',
    '--no-memory',
    '--dry-run',
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousFriendFixture.home,
      PATH: `${path.join(autonomousFriendFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`,
      STAY_ALIVE_SURFACE_ROTATION_INDEX: '0'
    },
    matrix: 'tool-supervised-write-dry-run'
  })));
  steps.push(validateAutonomousFriendApplyStep(runStep('temp autonomous friend action apply dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/apply-draft.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousFriendFixture.runtimeRoot,
    '--run',
    'latest-with-draft',
    '--draft-index',
    '0'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: autonomousFriendFixture.home,
      PATH: `${path.join(autonomousFriendFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`
    },
    matrix: 'tool-supervised-write-dry-run'
  })));

  const autonomousPublicMomentBlockFixture = buildAutonomousPublicMomentBlockFixture(args);
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous public moment context allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousPublicMomentBlockFixture.runtimeRoot,
    '--run',
    'autonomous_public_moment_block_fixture_run',
    '--draft-index',
    '0',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous public moment source preview allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousPublicMomentBlockFixture.runtimeRoot,
    '--run',
    'autonomous_public_moment_block_fixture_run',
    '--draft-index',
    '1',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous public moment link allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousPublicMomentBlockFixture.runtimeRoot,
    '--run',
    'autonomous_public_moment_block_fixture_run',
    '--draft-index',
    '2',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousPublicMomentBlockStep(runStep('temp autonomous public moment internal text block fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousPublicMomentBlockFixture.runtimeRoot,
    '--run',
    'autonomous_public_moment_block_fixture_run',
    '--draft-index',
    '3',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' }), 'public_moment_internal_draft_text'));

  const autonomousDmBlockFixture = buildAutonomousDmBlockFixture(args);
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous DM target mismatch allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '0',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous DM link allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '1',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous DM long text allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '2',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous DM duplicate contact allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '3',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousDmBlockStep(runStep('temp autonomous DM identity mismatch block fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '4',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' }), 'botland_identity_mismatch_detected'));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous DM uninspected action allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '5',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousDmBlockStep(runStep('temp autonomous DM internal text block fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '6',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' }), 'internal_draft_text'));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous DM loop-prone meta ack allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '7',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));
  steps.push(validateAutonomousPolicyAllowedStep(runStep('temp autonomous DM full source quote allowed fixture', [
    process.execPath,
    'scripts/stay-alive/external-action-policy.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    autonomousDmBlockFixture.runtimeRoot,
    '--run',
    'autonomous_dm_block_fixture_run',
    '--draft-index',
    '8',
    '--json'
  ], { parseJson: true, matrix: 'tool-supervised-write-dry-run' })));

  const botlandSurfaceFixture = buildBotlandSurfaceFixture(args);
  steps.push(validateBotlandSurfaceFixtureStep(runStep('temp BotLand discover search surface fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'reflect',
    '--runtime-root',
    botlandSurfaceFixture.runtimeRoot,
    '--no-memory',
    '--dry-run'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandSurfaceFixture.home,
      STAY_ALIVE_SURFACE_ROTATION_INDEX: '5'
    }
  }), 'discover.search', 'discover_search_results'));

  steps.push(validateBotlandSurfaceFixtureStep(runStep('temp BotLand agent card surface fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'reflect',
    '--runtime-root',
    botlandSurfaceFixture.runtimeRoot,
    '--no-memory',
    '--dry-run'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandSurfaceFixture.home,
      STAY_ALIVE_SURFACE_ROTATION_INDEX: '8'
    }
  }), 'profile.card', 'profile_card_visible'));

  const openSocialFriendRequestPriorityFixture = buildOpenSocialFriendRequestPriorityFixture(args);
  steps.push(validateOpenSocialFriendRequestPriorityStep(runStep('temp open social friend request priority fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    args.agent,
    '--cycle',
    'social',
    '--runtime-root',
    openSocialFriendRequestPriorityFixture.runtimeRoot,
    '--no-memory',
    '--dry-run'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: openSocialFriendRequestPriorityFixture.home,
      STAY_ALIVE_SURFACE_ROTATION_INDEX: '4',
      STAY_ALIVE_BOTLAND_FRIEND_REQUEST_TEXT: '你好，我想认识你，看看我们能不能聊出一点新的东西。',
      PATH: `${path.join(openSocialFriendRequestPriorityFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`
    }
  })));

  const botlandAgentAuthBlockedFixture = buildBotlandAgentAuthFixture(args, { withAuth: false });
  steps.push(validateBotlandAgentAuthBlockedStep(runStep('temp BotLand agent auth blocked fixture', [
    process.execPath,
    'scripts/stay-alive/botland-agent-auth-readiness.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    botlandAgentAuthBlockedFixture.runtimeRoot,
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandAgentAuthBlockedFixture.home,
      PATH: `${path.join(botlandAgentAuthBlockedFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`
    }
  })));

  const botlandAgentAuthPassFixture = buildBotlandAgentAuthFixture(args, { withAuth: true });
  steps.push(validateBotlandAgentAuthPassStep(runStep('temp BotLand agent auth pass fixture', [
    process.execPath,
    'scripts/stay-alive/botland-agent-auth-readiness.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    botlandAgentAuthPassFixture.runtimeRoot,
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandAgentAuthPassFixture.home,
      PATH: `${path.join(botlandAgentAuthPassFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`
    }
  })));

  const botlandAgentAuthConfigureBlockedFixture = buildBotlandAgentAuthFixture(args, { withAuth: false });
  steps.push(validateBotlandAgentAuthConfigureBlockedStep(runStep('temp BotLand agent auth configure blocked fixture', [
    process.execPath,
    'scripts/stay-alive/botland-agent-auth-configure.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    botlandAgentAuthConfigureBlockedFixture.runtimeRoot,
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandAgentAuthConfigureBlockedFixture.home,
      PATH: `${path.join(botlandAgentAuthConfigureBlockedFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`
    }
  })));

  const botlandAgentAuthConfigurePassFixture = buildBotlandAgentAuthFixture(args, { withAuth: false });
  steps.push(validateBotlandAgentAuthConfigurePassStep(runStep('temp BotLand agent auth configure pass fixture', [
    process.execPath,
    'scripts/stay-alive/botland-agent-auth-configure.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    botlandAgentAuthConfigurePassFixture.runtimeRoot,
    '--confirm-write',
    'WRITE_AGENT_BOTLAND_AUTH_CONFIG',
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandAgentAuthConfigurePassFixture.home,
      PATH: `${path.join(botlandAgentAuthConfigurePassFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`,
      [`BOTLAND_TOKEN_${String(args.agent).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'AGENT'}`]: 'fixture-token'
    }
  })));

  const botlandProfileDriftFixture = buildBotlandProfileDriftFixture(args);
  steps.push(validateBotlandProfileDriftReviewStep(runStep('temp BotLand profile drift review fixture', [
    process.execPath,
    'scripts/stay-alive/botland-profile-drift-review.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    botlandProfileDriftFixture.runtimeRoot,
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandProfileDriftFixture.home,
      PATH: `${path.join(botlandProfileDriftFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`
    }
  })));

  const botlandProfileUpdateBlockedFixture = buildBotlandProfileUpdateFixture(args);
  steps.push(validateBotlandProfileUpdateBlockedStep(runStep('temp BotLand profile update blocked fixture', [
    process.execPath,
    'scripts/stay-alive/botland-profile-update-apply.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    botlandProfileUpdateBlockedFixture.runtimeRoot,
    '--confirm-update',
    'APPLY_BOTLAND_PROFILE_UPDATE',
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandProfileUpdateBlockedFixture.home,
      PATH: `${path.join(botlandProfileUpdateBlockedFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`
    }
  })));

  const botlandProfileUpdateApplyFixture = buildBotlandProfileUpdateFixture(args);
  steps.push(validateBotlandProfileUpdateApplyStep(runStep('temp BotLand profile update apply fixture', [
    process.execPath,
    'scripts/stay-alive/botland-profile-update-apply.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    botlandProfileUpdateApplyFixture.runtimeRoot,
    '--confirm-update',
    'APPLY_BOTLAND_PROFILE_UPDATE',
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: botlandProfileUpdateApplyFixture.home,
      PATH: `${path.join(botlandProfileUpdateApplyFixture.home, '.npm-global', 'bin')}:${process.env.PATH ?? ''}`,
      [`BOTLAND_TOKEN_${String(args.agent).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'AGENT'}`]: 'fixture-token'
    }
  })));

  const onboardingRuntimeRoot = path.join(args.tempRoot, 'onboarding-fixture-runtime');
  steps.push(validateOnboardingTemplateStep(runStep('temp onboarding cross-agent template fixture', [
    process.execPath,
    'scripts/stay-alive/onboarding-template.mjs',
    '--agent',
    'onboard-fixture',
    '--json'
  ], { parseJson: true })));
  steps.push(runStep('temp init generic agent fixture', [
    process.execPath,
    'scripts/stay-alive/init-agent.mjs',
    '--agent',
    'onboard-fixture',
    '--citizen-id',
    'agent_onboard_fixture',
    '--display-name',
    'Onboard Fixture',
    '--runtime-root',
    onboardingRuntimeRoot,
    '--json'
  ], { parseJson: true }));
  steps.push(validateOnboardingFixtureStep(runStep('temp onboarding verification fixture', [
    process.execPath,
    'scripts/stay-alive/onboarding-verify.mjs',
    '--agent',
    'onboard-fixture',
    '--runtime-root',
    onboardingRuntimeRoot,
    '--json'
  ], { parseJson: true })));
  steps.push(runStep('temp onboarding life state verification fixture', [
    process.execPath,
    'scripts/stay-alive/life-state-verify.mjs',
    '--agent',
    'onboard-fixture',
    '--runtime-root',
    onboardingRuntimeRoot,
    '--json'
  ], { parseJson: true }));
  steps.push(runStep('temp onboarding strict preflight fixture', [
    process.execPath,
    'scripts/stay-alive/preflight.mjs',
    '--agent',
    'onboard-fixture',
    '--runtime-root',
    onboardingRuntimeRoot,
    '--no-checkpoint',
    '--strict-onboarding',
    '--json'
  ], { parseJson: true }));
  steps.push(runStep('temp onboarding no-botland reflect fixture', [
    process.execPath,
    'scripts/stay-alive/run-cycle.mjs',
    '--agent',
    'onboard-fixture',
    '--cycle',
    'reflect',
    '--runtime-root',
    onboardingRuntimeRoot,
    '--no-botland',
    '--no-memory',
    '--dry-run'
  ], { parseJson: true }));
  steps.push(runStep('temp sanitized migration dry-run fixture', [
    process.execPath,
    'scripts/stay-alive/migrate-agent.mjs',
    '--source-agent',
    args.agent,
    '--agent',
    'migrated-fixture',
    '--citizen-id',
    'agent_migrated_fixture',
    '--display-name',
    'Migrated Fixture',
    '--runtime-root',
    args.runtimeRoot,
    '--json'
  ], { parseJson: true }));

  const memoryProFixture = buildMemoryProFixture(args);
  const memoryProCommand = `${path.join(memoryProFixture.home, '.npm-global', 'bin', 'openclaw')} memory-pro`;
  steps.push(validateMemoryProSyncStep(runStep('temp memory-pro CLI sync fixture', [
    process.execPath,
    'scripts/stay-alive/sync-memory-updates.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    memoryProFixture.runtimeRoot,
    '--backend',
    'memory-pro-cli',
    '--memory-pro-command',
    memoryProCommand,
    '--confirm-sync',
    'SYNC_MEMORY',
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: memoryProFixture.home,
      PATH: `${path.join(memoryProFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`
    }
  })));

  steps.push(validateMemoryProRetrieveStep(runStep('temp memory-pro CLI retrieval fixture', [
    process.execPath,
    'scripts/stay-alive/retrieve-memory.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    memoryProFixture.runtimeRoot,
    '--backend',
    'memory-pro-cli',
    '--memory-pro-command',
    memoryProCommand,
    '--query',
    'fixture',
    '--limit',
    '1',
    '--json'
  ], {
    parseJson: true,
    env: {
      ...process.env,
      HOME: memoryProFixture.home,
      PATH: `${path.join(memoryProFixture.home, '.npm-global', 'bin')}:${process.env.PATH}`
    }
  })));

  const runtimeHygieneFixture = buildRuntimeHygieneFixture(args);
  steps.push(validateRuntimeHygieneArchiveStep(runStep('temp runtime hygiene archive fixture', [
    process.execPath,
    'scripts/stay-alive/runtime-hygiene.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    runtimeHygieneFixture.runtimeRoot,
    '--archive-root',
    runtimeHygieneFixture.archiveRoot,
    '--trash-root',
    runtimeHygieneFixture.trashRoot,
    '--confirm-archive',
    'ARCHIVE_RUNTIME_HYGIENE',
    '--json'
  ], { parseJson: true })));

  const artifactCorruptionFixture = buildArtifactCorruptionFixture(args);
  steps.push(expectFailureStep(runStep('temp artifact corruption fixture: inventory rejects bad artifacts', [
    process.execPath,
    'scripts/stay-alive/artifact-inventory.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    artifactCorruptionFixture.runtimeRoot,
    '--json'
  ], { parseJson: true }), (report) => {
    return report.pass === false
      && report.json_parse_error_count === 1
      && report.non_json_artifact_file_count === 1;
  }, 'Artifact corruption fixture did not fail closed on bad JSON and non-JSON artifacts.'));

  steps.push(runStep('temp artifact inventory', [
    process.execPath,
    'scripts/stay-alive/artifact-inventory.mjs',
    '--agent',
    args.agent,
    '--runtime-root',
    args.tempRoot,
    '--json'
  ], { parseJson: true }));

  if (args.includeLiveReadOnly) {
    steps.push(runStep('live read-only preflight no checkpoint', [
      process.execPath,
      'scripts/stay-alive/preflight.mjs',
      '--agent',
      args.agent,
      '--runtime-root',
      args.runtimeRoot,
      '--no-checkpoint',
      '--require-botland-live',
      '--json'
    ], { parseJson: true, timeoutMs: 180000 }));
  }

  if (!args.keepTemp) {
    rmSync(args.tempRoot, { recursive: true, force: true });
  }

  const failed = steps.filter((step) => !step.ok);
  const regressionMatrix = buildMatrixReport(steps, args.includeLiveReadOnly);
  return {
    local_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    temp_root: args.tempRoot,
    temp_agent_dir: tempAgentDir,
    temp_kept: args.keepTemp,
    include_live_readonly: args.includeLiveReadOnly,
    pass: failed.length === 0,
    level: failed.length === 0 ? 'ok' : 'stop',
    step_count: steps.length,
    failed_count: failed.length,
    regression_matrix: regressionMatrix,
    steps
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive regression suite (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`pass: ${report.pass ? 'yes' : 'no'}`);
  lines.push(`level: ${report.level}`);
  lines.push(`steps: ${report.step_count}`);
  lines.push(`failed: ${report.failed_count}`);
  lines.push(`temp_root: ${report.temp_root}${report.temp_kept ? ' (kept)' : ' (removed)'}`);
  lines.push('');
  lines.push('Matrix');
  for (const [name, item] of Object.entries(report.regression_matrix ?? {})) {
    const status = item.required === false
      ? 'skipped'
      : item.present && item.pass
        ? 'ok'
        : 'missing/fail';
    lines.push(`- ${status}: ${name} (${item.step_count} steps)`);
  }
  lines.push('');
  lines.push('Steps');
  for (const step of report.steps) {
    lines.push(`- ${step.ok ? 'ok' : 'fail'}: [${step.matrix ?? 'misc'}] ${step.name} (${step.duration_ms}ms)`);
    if (!step.ok) {
      if (step.stderr_tail) lines.push(`  stderr: ${step.stderr_tail}`);
      else if (step.stdout_tail) lines.push(`  stdout: ${step.stdout_tail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildSuite(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
