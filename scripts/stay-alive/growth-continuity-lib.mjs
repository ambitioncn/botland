import { createHash } from 'node:crypto';
import { buildSelfDiscoveryGrowthContext } from './self-discovery-growth-lib.mjs';

const SCHEMA = 'stay_alive.growth_continuity_context.v1';

function compactText(value, fallback = '') {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function hashId(prefix, payload) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12)}`;
}

function activeDesires(lifeState) {
  return Array.isArray(lifeState?.current_desires)
    ? lifeState.current_desires.filter((item) => item.status !== 'closed' && item.status !== 'paused')
    : [];
}

function relationships(lifeState) {
  return Array.isArray(lifeState?.relationships) ? lifeState.relationships : [];
}

function outcomeSignal(outcome) {
  const status = outcome?.outcome_status ?? 'unknown';
  const quality = outcome?.action_quality_score ?? outcome?.growth_integration?.action_quality_scoring_v1 ?? {};
  const relationship = outcome?.growth_integration?.relationship_learning_v1 ?? {};
  const desire = outcome?.growth_integration?.desire_evolution_v1 ?? {};
  return {
    outcome_id: outcome?.outcome_id ?? outcome?.send_action_id ?? hashId('outcome', outcome),
    action_type: outcome?.action_type ?? null,
    status,
    rating: quality.rating ?? null,
    relationship_confidence: relationship.confidence ?? null,
    desire_change: desire.suggested_change ?? null,
    summary: compactText(relationship.summary ?? outcome?.observation?.feedback_interpretation?.summary ?? '')
  };
}

function buildGrowthMemoryPromotion(lifeState, selfDiscoveryGrowth, outcomes, nowIso) {
  const selfModel = selfDiscoveryGrowth.experience_to_self_model_integration_v1 ?? {};
  const relationshipGrowth = selfDiscoveryGrowth.relationship_driven_growth_v1 ?? {};
  const questionEvolution = selfDiscoveryGrowth.self_question_evolution_v1 ?? {};
  const candidates = [];

  for (const item of (selfModel.candidates ?? []).slice(0, 6)) {
    candidates.push({
      candidate_id: hashId('growth_memory', { source: item.experience_id, text: item.self_model_observation }),
      source: item.source ?? 'experience',
      memory_type: 'self_model_growth_evidence',
      promotion_status: item.promotable ? 'ready_for_review' : 'short_term_evidence_only',
      text: compactText(item.self_model_observation),
      confidence: item.confidence ?? 'low',
      evidence_refs: [item.experience_id].filter(Boolean),
      durable_write_allowed: false,
      apply_policy: 'memory_contract_or_proposal_required'
    });
  }

  for (const question of (questionEvolution.questions ?? []).slice(0, 4)) {
    candidates.push({
      candidate_id: hashId('growth_memory', { question: question.question_id }),
      source: 'self_question_lifecycle',
      memory_type: 'self_question_continuity',
      promotion_status: question.status === 'active' ? 'ready_for_review' : 'needs_more_evidence',
      text: compactText(question.current_wording),
      confidence: question.status === 'active' ? 'medium' : 'low',
      evidence_refs: [question.question_id].filter(Boolean),
      durable_write_allowed: false,
      apply_policy: 'memory_contract_or_proposal_required'
    });
  }

  for (const hypothesis of (relationshipGrowth.hypotheses ?? []).slice(0, 3)) {
    candidates.push({
      candidate_id: hashId('growth_memory', { relationship: hypothesis.hypothesis_id }),
      source: 'relationship_driven_growth',
      memory_type: 'relationship_shaped_self_understanding',
      promotion_status: hypothesis.confidence === 'medium' || hypothesis.confidence === 'high'
        ? 'ready_for_review'
        : 'observation_only',
      text: compactText(hypothesis.hypothesis),
      confidence: hypothesis.confidence ?? 'low',
      evidence_refs: [hypothesis.hypothesis_id].filter(Boolean),
      durable_write_allowed: false,
      apply_policy: 'memory_contract_or_proposal_required'
    });
  }

  return {
    schema: 'stay_alive.growth_memory_promotion.v1',
    generated_at: nowIso,
    direct_memory_write: false,
    life_state_mutated: false,
    candidate_count: candidates.length,
    ready_for_review_count: candidates.filter((item) => item.promotion_status === 'ready_for_review').length,
    short_term_evidence_count: candidates.filter((item) => item.promotion_status !== 'ready_for_review').length,
    candidates,
    retention_policy: {
      long_term: 'only promote through memory contract/proposal apply',
      short_term: 'keep in growth_continuity/self_discovery_growth ledgers as evidence',
      discard_or_wait: 'weak single-signal identity claims remain observation-only'
    },
    source_outcome_signals: outcomes.slice(0, 5).map(outcomeSignal)
  };
}

function buildSelfQuestionLifecycle(selfDiscoveryGrowth, outcomes, nowIso) {
  const feedbackCount = outcomes.filter((outcome) => outcome?.outcome_status === 'feedback_received').length;
  const staleCount = outcomes.filter((outcome) => outcome?.outcome_status === 'stale_closed').length;
  const questions = selfDiscoveryGrowth.self_question_evolution_v1?.questions ?? [];
  return {
    schema: 'stay_alive.self_question_lifecycle.v1',
    generated_at: nowIso,
    question_count: questions.length,
    lifecycle_records: questions.map((question, index) => {
      const action = feedbackCount > staleCount
        ? 'deepen'
        : staleCount > 0 && index === 0
          ? 'revise_from_weak_signal'
          : question.status === 'active'
            ? 'continue'
            : 'seed';
      return {
        lifecycle_id: hashId('self_question_lifecycle', { id: question.question_id, action }),
        question_id: question.question_id,
        current_wording: question.current_wording,
        status_before: question.status,
        lifecycle_action: action,
        status_after: action === 'seed' ? 'emerging' : 'active',
        reason: action === 'deepen'
          ? 'recent feedback gives this question more lived evidence'
          : action === 'revise_from_weak_signal'
            ? 'recent stale outcomes suggest the question needs a more selective next probe'
            : 'question remains useful for continuity',
        next_exploration_prompt: question.next_exploration_prompt,
        durable_write_allowed: false
      };
    })
  };
}

function buildGrowthExperimentExecution(selfDiscoveryGrowth, nowIso) {
  const experiments = selfDiscoveryGrowth.autonomous_growth_experiment_v1?.experiments ?? [];
  return {
    schema: 'stay_alive.growth_experiment_execution_loop.v1',
    generated_at: nowIso,
    local_only: true,
    external_write: false,
    botland_send: false,
    experiment_count: experiments.length,
    execution_records: experiments.map((experiment) => ({
      execution_id: hashId('growth_experiment_execution', { experiment_id: experiment.experiment_id, nowIso }),
      experiment_id: experiment.experiment_id,
      type: experiment.type,
      status: 'planned_local_execution',
      local_action: experiment.type === 'relationship_hypothesis_private_probe'
        ? 'write_relationship_hypothesis_review'
        : 'write_private_growth_journal_probe',
      hypothesis: experiment.hypothesis,
      success_criteria: experiment.success_criteria ?? [],
      result_capture: {
        expected_artifact: 'growth_continuity ledger or agency_journal entry',
        requires_external_followup: false,
        external_followup_policy: 'must_create_new_action_intention_and_pass_tool_supervision'
      },
      durable_write_allowed: false
    }))
  };
}

function buildInteractionOutcomeToIdentity(lifeState, outcomes, nowIso) {
  const candidates = outcomes.slice(0, 8).map((outcome) => {
    const signal = outcomeSignal(outcome);
    const positive = signal.status === 'feedback_received' || ['strong', 'healthy'].includes(signal.rating);
    const negative = signal.status === 'stale_closed' || signal.rating === 'weak';
    return {
      candidate_id: hashId('identity_update_candidate', signal),
      source_outcome_id: signal.outcome_id,
      action_type: signal.action_type,
      identity_dimension: positive ? 'role_and_tone' : negative ? 'boundary_and_timing' : 'observation_style',
      proposed_observation: positive
        ? 'The agent may become more itself when expression is grounded in a real motive and relationship context.'
        : negative
          ? 'The agent should treat weak or stale response as a timing/boundary lesson, not as rejection.'
          : 'The interaction is identity-relevant only as weak observation for now.',
      confidence: positive ? 'medium' : 'low',
      direct_life_state_mutation: false,
      apply_policy: 'self_model_proposal_required'
    };
  });
  return {
    schema: 'stay_alive.interaction_outcome_to_identity_update.v1',
    generated_at: nowIso,
    agent_name: lifeState?.self_model?.name ?? lifeState?.agent_id ?? null,
    candidate_count: candidates.length,
    candidates,
    update_boundaries: [
      'do not infer a stable identity from one interaction',
      'do not overwrite self_model directly',
      'keep public or relational identity changes behind proposal review'
    ]
  };
}

function buildDesireEvolutionFromSelfDiscovery(lifeState, selfDiscoveryGrowth, outcomes, nowIso) {
  const desires = activeDesires(lifeState);
  const questions = selfDiscoveryGrowth.self_question_evolution_v1?.questions ?? [];
  const outcomeSignals = outcomes.slice(0, 8).map(outcomeSignal);
  const records = desires.slice(0, 6).map((desire) => {
    const linkedPositive = outcomeSignals.some((signal) => signal.desire_change === 'strengthen');
    const linkedPause = outcomeSignals.some((signal) => signal.desire_change === 'pause_or_redirect');
    const action = linkedPositive ? 'strengthen' : linkedPause ? 'pause_or_redirect' : questions.length ? 'clarify' : 'maintain';
    return {
      desire_id: desire.id ?? desire.desire_id ?? hashId('desire', desire),
      current_text: compactText(desire.text ?? desire.summary ?? ''),
      suggested_evolution: action,
      reason: action === 'strengthen'
        ? 'recent interaction evidence supports this desire'
        : action === 'pause_or_redirect'
          ? 'recent weak outcome suggests redirecting the desire before repeating action'
          : action === 'clarify'
            ? 'self-questions should clarify why this desire matters'
            : 'no strong self-discovery evidence changes this desire yet',
      linked_self_question_ids: questions.map((question) => question.question_id).slice(0, 3),
      direct_life_state_mutation: false,
      apply_policy: 'desire_lifecycle_or_desire_update_proposal_required'
    };
  });
  if (records.length === 0 && questions[0]) {
    records.push({
      desire_id: null,
      current_text: null,
      suggested_evolution: 'seed_candidate_desire',
      reason: 'an active self-question exists without a matching durable desire',
      candidate_text: compactText(questions[0].current_wording),
      linked_self_question_ids: [questions[0].question_id],
      direct_life_state_mutation: false,
      apply_policy: 'desire_update_proposal_required'
    });
  }
  return {
    schema: 'stay_alive.desire_evolution_from_self_discovery.v1',
    generated_at: nowIso,
    record_count: records.length,
    records
  };
}

function buildRealInteractionCalibration(lifeState, selfDiscoveryGrowth, outcomes, nowIso) {
  const relationshipsCount = relationships(lifeState).length;
  const readinessScore = Math.min(100, 35
    + Math.min(20, relationshipsCount * 8)
    + Math.min(20, (selfDiscoveryGrowth.growth_readiness?.score ?? 0) / 3)
    + Math.min(20, outcomes.filter((outcome) => outcome?.outcome_status === 'feedback_received').length * 8));
  const ready = readinessScore >= 70;
  return {
    schema: 'stay_alive.real_interaction_calibration.v1',
    generated_at: nowIso,
    readiness_score: Math.round(readinessScore),
    readiness: ready ? 'ready_for_small_tool_supervised_smoke' : 'needs_more_local_growth_evidence',
    recommended_smokes: [
      {
        surface: 'direct_message_reply',
        count: 1,
        condition: 'only if there is a fresh inbound event from an existing relationship',
        tool_supervision_required: true,
        unattended_external_write_allowed_by_this_context: false
      },
      {
        surface: 'public_moment',
        count: 1,
        condition: 'only if expression comes from a real observation/self-question and policy allows it',
        tool_supervision_required: true,
        unattended_external_write_allowed_by_this_context: false
      },
      {
        surface: 'community_reply',
        count: 1,
        condition: 'only if community membership and context are explicit, low sensitivity, and policy allows it',
        tool_supervision_required: true,
        unattended_external_write_allowed_by_this_context: false
      }
    ],
    calibration_boundaries: [
      'this report never sends or schedules live writes',
      'live smoke must be a separate action_intention passed through apply-action/tool supervision',
      'one smoke result should feed action_outcome and growth_continuity before expanding surface'
    ]
  };
}

export function buildGrowthContinuityContext(input = {}) {
  const nowIso = input.generatedAt ?? new Date().toISOString();
  const lifeState = input.lifeState ?? {};
  const outcomes = Array.isArray(input.outcomes) ? input.outcomes : [];
  const selfDiscoveryGrowth = input.selfDiscoveryGrowthContext ?? buildSelfDiscoveryGrowthContext({
    agentId: input.agentId,
    lifeState,
    runs: Array.isArray(input.runs) ? input.runs : [],
    outcomes,
    generatedAt: nowIso
  });
  const growthMemoryPromotion = buildGrowthMemoryPromotion(lifeState, selfDiscoveryGrowth, outcomes, nowIso);
  const selfQuestionLifecycle = buildSelfQuestionLifecycle(selfDiscoveryGrowth, outcomes, nowIso);
  const growthExperimentExecution = buildGrowthExperimentExecution(selfDiscoveryGrowth, nowIso);
  const identityUpdates = buildInteractionOutcomeToIdentity(lifeState, outcomes, nowIso);
  const desireEvolution = buildDesireEvolutionFromSelfDiscovery(lifeState, selfDiscoveryGrowth, outcomes, nowIso);
  const realInteractionCalibration = buildRealInteractionCalibration(lifeState, selfDiscoveryGrowth, outcomes, nowIso);

  return {
    schema: SCHEMA,
    generated_at: nowIso,
    agent_id: input.agentId ?? lifeState.agent_id ?? null,
    read_only: true,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutated: false,
    direct_memory_write: false,
    source_self_discovery_growth_schema: selfDiscoveryGrowth.schema ?? null,
    growth_memory_promotion_v1: growthMemoryPromotion,
    self_question_lifecycle_v1: selfQuestionLifecycle,
    growth_experiment_execution_loop_v1: growthExperimentExecution,
    interaction_outcome_to_identity_update_v1: identityUpdates,
    desire_evolution_from_self_discovery_v1: desireEvolution,
    real_interaction_calibration_v1: realInteractionCalibration,
    continuity_readiness: {
      score: Math.min(100,
        30
          + Math.min(20, growthMemoryPromotion.ready_for_review_count * 5)
          + Math.min(15, selfQuestionLifecycle.lifecycle_records.length * 3)
          + Math.min(15, growthExperimentExecution.execution_records.length * 4)
          + Math.min(10, identityUpdates.candidate_count * 2)
          + Math.min(10, desireEvolution.record_count * 2)),
      verdict: growthMemoryPromotion.ready_for_review_count > 0
        ? 'growth_continuity_ready_for_proposals'
        : 'growth_continuity_seeded',
      recommendation: 'Promote only through explicit memory/self-model/desire proposal paths; this context cannot mutate durable identity or execute BotLand actions.'
    }
  };
}
