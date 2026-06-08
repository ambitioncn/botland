import { createHash } from 'node:crypto';

const SCHEMA = 'stay_alive.durable_becoming_context.v1';

function compactText(value, fallback = '') {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  return text.length > 360 ? `${text.slice(0, 357)}...` : text;
}

function hashId(prefix, payload) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 14)}`;
}

function stableHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function latestGrowthApply(input) {
  if (input.growthApplyContext?.schema === 'stay_alive.growth_apply_context.v1') return input.growthApplyContext;
  return (input.runs ?? [])
    .map((run) => run?.growth_apply_context)
    .find((context) => context?.schema === 'stay_alive.growth_apply_context.v1')
    ?? (input.growthApplyLedgers ?? []).find((context) => context?.schema === 'stay_alive.growth_apply_context.v1')
    ?? null;
}

function activeDesires(lifeState) {
  return Array.isArray(lifeState?.current_desires)
    ? lifeState.current_desires.filter((desire) => !['closed', 'dismissed', 'expired'].includes(desire.status))
    : [];
}

function buildGrowthProposalApplyPipeline(growthApply, nowIso) {
  const promotion = growthApply?.growth_promotion_apply_v1 ?? {};
  const memoryProposals = promotion.memory_proposals ?? [];
  const selfModelProposals = promotion.self_model_patch_proposals ?? [];
  const rawDesireProposals = [
    ...(promotion.desire_lifecycle_proposals ?? []),
    ...(growthApply?.desire_lifecycle_apply_v1?.proposals ?? []).map((item) => ({
      proposal_id: item.lifecycle_id,
      proposal_type: 'desire_lifecycle_candidate',
      payload: item.proposal_payload,
      direct_life_state_mutation: false
    }))
  ];
  const desireProposals = [...new Map(rawDesireProposals.map((proposal) => [
    `${proposal.payload?.desire_id ?? ''}:${proposal.payload?.next_status ?? ''}:${stableHash(proposal.payload ?? proposal)}`,
    proposal
  ])).values()];
  const applicationPlans = [
    ...memoryProposals.map((proposal) => ({
      application_id: hashId('growth_apply_memory', proposal),
      target_surface: 'durable_memory',
      source_proposal_id: proposal.proposal_id,
      proposal_type: proposal.proposal_type,
      proposed_payload_hash: stableHash(proposal.payload ?? proposal),
      proposed_payload: proposal.payload ?? null,
      status: 'ready_for_confirmed_local_apply',
      apply_route: 'apply-durable-becoming -> memory_updates ledger -> optional memory backend sync',
      direct_memory_write: false,
      direct_life_state_mutation: false,
      confirmation_required: 'APPLY_DURABLE_BECOMING'
    })),
    ...selfModelProposals.map((proposal) => ({
      application_id: hashId('growth_apply_self_model', proposal),
      target_surface: 'self_model_version_candidate',
      source_proposal_id: proposal.proposal_id,
      proposal_type: proposal.proposal_type,
      proposed_payload_hash: stableHash(proposal.payload ?? proposal),
      proposed_payload: proposal.payload ?? null,
      status: 'ready_for_versioned_patch_candidate',
      apply_route: 'apply-durable-becoming -> self_model_versions ledger; life_state mutation remains disabled',
      direct_memory_write: false,
      direct_life_state_mutation: false,
      confirmation_required: 'APPLY_DURABLE_BECOMING'
    })),
    ...desireProposals.map((proposal) => ({
      application_id: hashId('growth_apply_desire', proposal),
      target_surface: 'desire_state_machine_transition',
      source_proposal_id: proposal.proposal_id,
      proposal_type: proposal.proposal_type ?? 'desire_lifecycle_candidate',
      desire_id: proposal.payload?.desire_id ?? null,
      next_status: proposal.payload?.next_status ?? null,
      proposed_payload_hash: stableHash(proposal.payload ?? proposal),
      proposed_payload: proposal.payload ?? null,
      status: 'ready_for_state_machine_transition_candidate',
      apply_route: 'apply-durable-becoming -> desire_state_machine ledger -> controlled life_state.current_desires state-machine metadata',
      direct_memory_write: false,
      direct_life_state_mutation: false,
      confirmation_required: 'APPLY_DURABLE_BECOMING'
    }))
  ];
  return {
    schema: 'stay_alive.growth_proposal_apply_pipeline.v1',
    generated_at: nowIso,
    local_only: true,
    external_write: false,
    botland_send: false,
    source_growth_apply_schema: growthApply?.schema ?? null,
    proposal_counts: {
      memory: memoryProposals.length,
      self_model_patch: selfModelProposals.length,
      desire_lifecycle: desireProposals.length,
      application_plan: applicationPlans.length
    },
    application_plans: applicationPlans,
    apply_policy: [
      'default durable becoming context is evidence only',
      'application ledgers require explicit write confirmation',
      'long-term memory sync, life_state mutation, and BotLand writes remain separate gates'
    ]
  };
}

function buildSelfModelVersioning(lifeState, growthApply, nowIso) {
  const selfModel = lifeState?.self_model ?? {};
  const governanceDecisions = growthApply?.identity_patch_governance_v1?.decisions ?? [];
  const eligible = governanceDecisions
    .filter((decision) => decision.governance_decision === 'eligible_for_self_model_patch_proposal')
    .slice(0, 6);
  const currentVersion = {
    version_id: hashId('self_model_version', selfModel),
    content_hash: stableHash(selfModel),
    name: selfModel.name ?? null,
    value_count: Array.isArray(selfModel.values) ? selfModel.values.length : 0,
    boundary_count: Array.isArray(selfModel.boundaries) ? selfModel.boundaries.length : 0
  };
  const patchCandidates = eligible.map((decision) => ({
    patch_id: hashId('self_model_patch', decision),
    base_version_id: currentVersion.version_id,
    identity_dimension: decision.identity_dimension,
    operation: 'append_observation',
    proposed_observation: compactText(decision.proposed_observation),
    evidence_refs: decision.evidence_refs ?? [],
    confidence: decision.evidence_count >= 2 ? 'medium' : 'low',
    version_preview_id: hashId('self_model_version_preview', {
      base: currentVersion.version_id,
      patch: decision.proposed_observation
    }),
    rollback_hint: 'remove this patch ledger or supersede with a later self_model_versions ledger',
    direct_life_state_mutation: false
  }));
  return {
    schema: 'stay_alive.self_model_versioning.v1',
    generated_at: nowIso,
    local_only: true,
    current_version: currentVersion,
    patch_candidate_count: patchCandidates.length,
    patch_candidates: patchCandidates,
    governance: {
      requires_additive_patch: true,
      requires_provenance: true,
      overwrite_allowed: false,
      direct_life_state_mutation: false
    }
  };
}

function buildDesireStateMachine(lifeState, growthApply, nowIso) {
  const allowedStates = ['seeded', 'active', 'clarified', 'strengthened', 'paused', 'decayed', 'merged', 'fulfilled', 'dismissed'];
  const desireMap = new Map(activeDesires(lifeState).map((desire) => [desire.id, desire]));
  const proposals = growthApply?.desire_lifecycle_apply_v1?.proposals ?? [];
  const transitions = proposals
    .filter((proposal) => proposal.desire_id && desireMap.has(proposal.desire_id))
    .slice(0, 8)
    .map((proposal) => {
      const current = desireMap.get(proposal.desire_id);
      const suggested = proposal.suggested_evolution;
      const transition = suggested === 'strengthen'
        ? 'strengthen'
        : suggested === 'clarify'
          ? 'clarify'
          : proposal.next_status === 'paused'
            ? 'pause'
            : 'maintain';
      const nextState = transition === 'strengthen'
        ? 'strengthened'
        : transition === 'clarify'
          ? 'clarified'
          : proposal.next_status ?? current.status ?? 'active';
      return {
        transition_id: hashId('desire_transition', proposal),
        desire_id: proposal.desire_id,
        current_status: current.status ?? 'active',
        state_machine_transition: transition,
        next_status: allowedStates.includes(nextState) ? nextState : 'active',
        source_lifecycle_id: proposal.lifecycle_id,
        evidence_reason: compactText(proposal.proposal_payload?.evidence?.reason),
        apply_route: 'desire_state_machine ledger -> apply-desire-lifecycle confirmation',
        direct_life_state_mutation: false
      };
    });
  return {
    schema: 'stay_alive.desire_state_machine.v1',
    generated_at: nowIso,
    local_only: true,
    allowed_states: allowedStates,
    active_desire_count: desireMap.size,
    transition_count: transitions.length,
    transitions,
    planner_integration_hint: transitions.length > 0
      ? 'planner can use transition evidence as motivation and cooldown context without mutating desires'
      : 'no desire transition is ready; keep using current active desires'
  };
}

function buildGrowthMemoryRetrieval(memoryRetrieval, growthApply, nowIso) {
  const memories = memoryRetrieval?.memories ?? [];
  const proposedMemoryTexts = growthApply?.growth_promotion_apply_v1?.memory_proposals
    ?.map((proposal) => proposal.payload?.text)
    .filter(Boolean) ?? [];
  const growthMemoryHits = memories.filter((memory) => {
    const text = `${memory.category ?? ''} ${memory.content ?? ''} ${memory.text ?? ''}`.toLowerCase();
    return text.includes('growth') || text.includes('self') || text.includes('desire') || text.includes('成长') || text.includes('自我');
  });
  return {
    schema: 'stay_alive.growth_memory_retrieval.v1',
    generated_at: nowIso,
    read_only: true,
    backend: memoryRetrieval?.backend ?? null,
    query: memoryRetrieval?.query ?? null,
    retrieved_count: memories.length,
    growth_memory_hit_count: growthMemoryHits.length,
    proposed_growth_memory_count: proposedMemoryTexts.length,
    retrieved_growth_memories: growthMemoryHits.slice(0, 5).map((memory) => ({
      memory_id: memory.memory_id ?? memory.id ?? null,
      category: memory.category ?? null,
      score: memory.score ?? null,
      preview: compactText(memory.content ?? memory.text)
    })),
    retrieval_quality: memories.length === 0
      ? 'no_retrieval_available'
      : growthMemoryHits.length > 0
        ? 'growth_memory_available_for_planning'
        : proposedMemoryTexts.length > 0
          ? 'proposal_memory_exists_but_not_yet_retrieved'
          : 'general_memory_only',
    direct_memory_write: false
  };
}

function buildRealInteractionSmokeLoop(growthApply, outcomes, nowIso) {
  const smokePlans = growthApply?.real_interaction_calibration_smoke_v1?.smoke_plans ?? [];
  const recentOutcomeTypes = new Set((outcomes ?? []).map((outcome) => outcome?.action_type).filter(Boolean));
  const loops = smokePlans.map((plan) => ({
    loop_id: hashId('real_smoke_loop', plan),
    surface: plan.surface,
    readiness: plan.readiness,
    execute_now: false,
    recent_outcome_exists: recentOutcomeTypes.has(plan.surface),
    loop_stages: [
      'action_intention',
      'tool_supervision_decision',
      'external_action_record',
      'post_action_inspection',
      'action_outcome',
      'growth_continuity',
      'growth_apply',
      'durable_becoming'
    ],
    current_stage: plan.block_reason ? 'blocked_before_action_intention' : 'ready_for_fresh_action_intention',
    block_reason: plan.block_reason ?? null,
    tool_supervision_required: true,
    result_capture_route: 'action-outcome -> durable-becoming after inspection',
    external_write_authorized_by_this_context: false
  }));
  return {
    schema: 'stay_alive.real_interaction_smoke_loop.v1',
    generated_at: nowIso,
    local_only: true,
    external_write: false,
    botland_send: false,
    loop_count: loops.length,
    loops,
    safety_boundary: 'smoke loop context can recommend the next lifecycle stage, but live BotLand execution must come from a fresh supervised action intention'
  };
}

export function buildDurableBecomingContext(input = {}) {
  const nowIso = input.generatedAt ?? new Date().toISOString();
  const lifeState = input.lifeState ?? {};
  const growthApply = latestGrowthApply(input);
  const pipeline = buildGrowthProposalApplyPipeline(growthApply, nowIso);
  const selfModelVersioning = buildSelfModelVersioning(lifeState, growthApply, nowIso);
  const desireStateMachine = buildDesireStateMachine(lifeState, growthApply, nowIso);
  const memoryRetrieval = buildGrowthMemoryRetrieval(input.memoryRetrieval, growthApply, nowIso);
  const smokeLoop = buildRealInteractionSmokeLoop(growthApply, input.outcomes ?? [], nowIso);
  const score = Math.min(100,
    25
      + Math.min(25, pipeline.proposal_counts.application_plan * 4)
      + Math.min(20, selfModelVersioning.patch_candidate_count * 5)
      + Math.min(15, desireStateMachine.transition_count * 4)
      + Math.min(10, memoryRetrieval.growth_memory_hit_count * 3)
      + Math.min(10, smokeLoop.loop_count * 2));
  return {
    schema: SCHEMA,
    generated_at: nowIso,
    agent_id: input.agentId ?? lifeState.agent_id ?? null,
    local_only: true,
    external_write: false,
    botland_send: false,
    direct_memory_write: false,
    life_state_mutated: false,
    source_growth_apply_schema: growthApply?.schema ?? null,
    growth_proposal_apply_pipeline_v1: pipeline,
    self_model_versioning_v1: selfModelVersioning,
    desire_state_machine_v1: desireStateMachine,
    growth_memory_retrieval_v1: memoryRetrieval,
    real_interaction_smoke_loop_v1: smokeLoop,
    durable_becoming_readiness: {
      score,
      verdict: pipeline.proposal_counts.application_plan > 0 || selfModelVersioning.patch_candidate_count > 0 || desireStateMachine.transition_count > 0
        ? 'ready_for_confirmed_local_application_ledgers'
        : 'needs_more_growth_apply_evidence',
      recommendation: 'Keep durable self changes versioned and provenance-carrying; do not mutate life_state or send BotLand actions from this context alone.'
    }
  };
}
