import { createHash } from 'node:crypto';

const SCHEMA = 'stay_alive.self_discovery_growth_context.v1';

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function compactText(value, fallback = '') {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
}

function activeDesires(lifeState) {
  return Array.isArray(lifeState?.current_desires)
    ? lifeState.current_desires.filter((item) => item.status !== 'closed' && item.status !== 'paused')
    : [];
}

function relationships(lifeState) {
  return Array.isArray(lifeState?.relationships) ? lifeState.relationships : [];
}

function hashId(prefix, payload) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12)}`;
}

function outcomeSignal(outcome) {
  const quality = outcome?.action_quality_score ?? outcome?.growth_integration?.action_quality_scoring_v1 ?? {};
  const relationship = outcome?.growth_integration?.relationship_learning_v1 ?? {};
  const desire = outcome?.growth_integration?.desire_evolution_v1 ?? {};
  const status = outcome?.outcome_status ?? 'unknown';
  const score = (status === 'feedback_received' ? 16 : 0)
    + (status === 'stale_closed' ? -14 : 0)
    + (quality.rating === 'strong' ? 12 : quality.rating === 'healthy' ? 7 : quality.rating === 'weak' ? -8 : 0)
    + (relationship.confidence === 'medium' ? 5 : relationship.confidence === 'high' ? 8 : 0)
    + (desire.suggested_change === 'strengthen' ? 6 : desire.suggested_change === 'pause_or_redirect' ? -8 : 0);
  return clampNumber(score, -24, 36);
}

function buildSelfQuestionEvolution(lifeState, runs, outcomes, nowIso) {
  const desires = activeDesires(lifeState);
  const rels = relationships(lifeState);
  const latestAgency = runs.find((run) => run?.agency_summary?.self_discovery?.questions?.length) ?? null;
  const latestQuestion = latestAgency?.agency_summary?.self_discovery?.questions?.[0]?.question ?? null;
  const feedbackOutcomes = outcomes.filter((outcome) => outcome?.outcome_status === 'feedback_received');
  const staleOutcomes = outcomes.filter((outcome) => outcome?.outcome_status === 'stale_closed');
  const theme = desires[0]?.text ?? lifeState?.life_theme ?? lifeState?.self_model?.values?.[0] ?? 'identity continuity';
  const question = latestQuestion
    ?? `What is ${lifeState?.self_model?.name ?? lifeState?.agent_id ?? 'the agent'} learning to care about through interaction, not assignment?`;
  const pressure = feedbackOutcomes.length > staleOutcomes.length
    ? 'interaction_feedback_is_teaching'
    : staleOutcomes.length > 0
      ? 'avoid_repeating_weak_interactions'
      : 'needs_more_experience_evidence';
  return {
    schema: 'stay_alive.self_question_evolution.v1',
    generated_at: nowIso,
    questions: [
      {
        question_id: hashId('self_question', { question, theme }),
        theme: 'intrinsic_direction',
        current_wording: question,
        status: feedbackOutcomes.length > 0 || desires.length > 0 ? 'active' : 'emerging',
        source: latestQuestion ? 'agency_summary.self_discovery' : 'self_discovery_growth_v1',
        evidence: {
          active_desire_count: desires.length,
          relationship_count: rels.length,
          feedback_outcome_count: feedbackOutcomes.length,
          stale_outcome_count: staleOutcomes.length,
          pressure
        },
        next_exploration_prompt: `Use the next private growth pass to test whether "${compactText(theme)}" still feels true after recent interaction evidence.`
      },
      {
        question_id: hashId('self_question', { relationship: rels[0]?.target_id ?? rels[0]?.name ?? 'none' }),
        theme: 'relationship_shaped_self',
        current_wording: rels.length > 0
          ? `How should ${rels[0].name ?? rels[0].target_id} change how I understand my role?`
          : 'Which observed person or agent should become the first relationship-shaped self-question?',
        status: rels.length > 0 ? 'active' : 'emerging',
        source: 'relationship_driven_growth_v1',
        evidence: {
          relationship_count: rels.length,
          latest_relationship: rels[0]?.name ?? rels[0]?.target_id ?? null
        },
        next_exploration_prompt: 'Name one change in self-understanding before planning another external expression.'
      }
    ]
  };
}

function buildExperienceToSelfModel(lifeState, runs, outcomes, nowIso) {
  const experiences = [];
  for (const outcome of outcomes.slice(0, 8)) {
    const growth = outcome.growth_integration ?? {};
    const signal = outcomeSignal(outcome);
    experiences.push({
      experience_id: outcome.outcome_id ?? outcome.send_action_id ?? hashId('experience', outcome),
      source: 'action_outcome',
      action_type: outcome.action_type ?? null,
      outcome_status: outcome.outcome_status ?? null,
      signal_score: signal,
      self_model_observation: signal > 12
        ? 'This interaction is evidence that the agent can turn desire into relationship-aware action.'
        : signal < 0
          ? 'This interaction is evidence to become more selective before acting again.'
          : 'This interaction is observation-only until stronger feedback arrives.',
      confidence: signal >= 18 ? 'medium' : signal < 0 ? 'low_negative' : 'low',
      promotable: signal >= 18,
      related_desire_id: growth.desire_evolution_v1?.primary_desire_id ?? null,
      related_relationship_summary: compactText(growth.relationship_learning_v1?.summary ?? growth.relationship_learning ?? '')
    });
  }
  const agencyRuns = runs.filter((run) => run?.agency_summary?.schema === 'stay_alive.agency_core.v1').slice(0, 3);
  for (const run of agencyRuns) {
    experiences.push({
      experience_id: run.run_id ?? hashId('experience', run),
      source: 'agency_cycle',
      action_type: 'agency_experiment_plan',
      outcome_status: 'private_growth_evidence',
      signal_score: 10,
      self_model_observation: compactText(run.agency_summary?.growth_journal?.entries?.[0]?.text, 'Agency cycle produced self-authored growth evidence.'),
      confidence: 'low',
      promotable: false,
      related_desire_id: null,
      related_relationship_summary: null
    });
  }
  return {
    schema: 'stay_alive.experience_to_self_model_integration.v1',
    generated_at: nowIso,
    direct_life_state_mutation: false,
    candidate_count: experiences.length,
    candidates: experiences,
    memory_update_candidate: {
      type: 'stay_alive_self_model_growth_evidence',
      status: 'proposed',
      text: experiences[0]?.self_model_observation ?? 'No interaction evidence is ready for self-model integration yet.',
      evidence: {
        candidate_count: experiences.length,
        promotable_count: experiences.filter((item) => item.promotable).length
      },
      apply_policy: 'operator_review_required'
    }
  };
}

function buildRelationshipDrivenGrowth(lifeState, outcomes, nowIso) {
  const rels = relationships(lifeState);
  const relationshipOutcomes = outcomes
    .map((outcome) => outcome?.growth_integration?.relationship_learning_v1)
    .filter(Boolean);
  const primary = rels[0] ?? {};
  const latestLearning = relationshipOutcomes[0] ?? null;
  return {
    schema: 'stay_alive.relationship_driven_growth.v1',
    generated_at: nowIso,
    relationship_count: rels.length,
    learning_signal_count: relationshipOutcomes.length,
    hypotheses: [
      {
        hypothesis_id: hashId('relationship_growth', { primary, latestLearning }),
        target_id: primary.target_id ?? primary.citizen_id ?? null,
        target_name: primary.name ?? primary.display_name ?? null,
        source: latestLearning ? 'action_outcome.relationship_learning_v1' : 'life_state.relationships',
        hypothesis: latestLearning?.summary
          ?? (rels.length > 0
            ? `This relationship should shape the agent's tone and timing before it expands action surface.`
            : 'The agent needs a first durable relationship hypothesis from observed interaction.'),
        confidence: latestLearning?.confidence ?? (rels.length > 0 ? 'low' : 'missing'),
        next_growth_move: latestLearning
          ? 'Use this relationship learning as context for the next self-question before external action.'
          : 'Collect one more observation before creating a durable relationship update.'
      }
    ]
  };
}

function buildAutonomousGrowthExperiment(lifeState, questionEvolution, relationshipGrowth, nowIso) {
  const desires = activeDesires(lifeState);
  const question = questionEvolution.questions[0];
  const relationship = relationshipGrowth.hypotheses[0];
  return {
    schema: 'stay_alive.autonomous_growth_experiment.v1',
    generated_at: nowIso,
    external_write: false,
    botland_send: false,
    tool_supervision_required_for_external_followup: true,
    experiments: [
      {
        experiment_id: hashId('growth_experiment', { question: question.current_wording, nowIso }),
        type: 'self_question_private_probe',
        summary: `Privately answer: ${question.current_wording}`,
        hypothesis: 'If the agent can answer its own question before acting, later external expression will be less mechanical.',
        success_criteria: [
          'names one changed self-understanding',
          'links the change to one desire or relationship',
          'states one boundary that keeps the next action safe'
        ],
        risk: 'low',
        external_write: false,
        related_desire_id: desires[0]?.id ?? desires[0]?.desire_id ?? null,
        related_self_question_id: question.question_id
      },
      {
        experiment_id: hashId('growth_experiment', { relationship: relationship.hypothesis, nowIso }),
        type: 'relationship_hypothesis_private_probe',
        summary: relationship.next_growth_move,
        hypothesis: relationship.hypothesis,
        success_criteria: [
          'describes what changed in relationship understanding',
          'does not infer intimacy from one weak signal',
          'keeps any external follow-up behind tool supervision'
        ],
        risk: 'low',
        external_write: false,
        related_relationship_target_id: relationship.target_id
      }
    ]
  };
}

export function buildSelfDiscoveryGrowthContext(input = {}) {
  const nowIso = input.generatedAt ?? new Date().toISOString();
  const lifeState = input.lifeState ?? {};
  const runs = Array.isArray(input.runs) ? input.runs : [];
  const outcomes = Array.isArray(input.outcomes) ? input.outcomes : [];
  const questionEvolution = buildSelfQuestionEvolution(lifeState, runs, outcomes, nowIso);
  const selfModelIntegration = buildExperienceToSelfModel(lifeState, runs, outcomes, nowIso);
  const relationshipGrowth = buildRelationshipDrivenGrowth(lifeState, outcomes, nowIso);
  const growthExperiment = buildAutonomousGrowthExperiment(lifeState, questionEvolution, relationshipGrowth, nowIso);
  const score = clampNumber(
    42
      + Math.min(16, questionEvolution.questions.filter((item) => item.status === 'active').length * 7)
      + Math.min(20, selfModelIntegration.candidates.filter((item) => item.promotable).length * 8)
      + Math.min(14, relationshipGrowth.learning_signal_count * 5)
      + Math.min(10, growthExperiment.experiments.length * 3),
    0,
    100
  );
  return {
    schema: SCHEMA,
    generated_at: nowIso,
    agent_id: input.agentId ?? lifeState.agent_id ?? null,
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutated: false,
    inspected: {
      run_count: runs.length,
      outcome_count: outcomes.length,
      active_desire_count: activeDesires(lifeState).length,
      relationship_count: relationships(lifeState).length
    },
    self_question_evolution_v1: questionEvolution,
    experience_to_self_model_integration_v1: selfModelIntegration,
    relationship_driven_growth_v1: relationshipGrowth,
    autonomous_growth_experiment_v1: growthExperiment,
    growth_readiness: {
      score,
      verdict: score >= 72 ? 'growth_loop_visible' : score >= 55 ? 'growth_loop_seeded' : 'needs_more_interaction_evidence',
      recommendation: 'Use this as planner evidence and memory proposal material; do not mutate durable self-model or bypass tool supervision.'
    }
  };
}
