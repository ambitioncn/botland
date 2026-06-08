import { createHash } from 'node:crypto';

const SCHEMA = 'stay_alive.growth_apply_context.v1';

function compactText(value, fallback = '') {
  const text = String(value ?? fallback).replace(/\s+/g, ' ').trim();
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

function hashId(prefix, payload) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 14)}`;
}

function stableKey(text) {
  return compactText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function minIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function activeDesires(lifeState) {
  return Array.isArray(lifeState?.current_desires)
    ? lifeState.current_desires.filter((item) => item.status !== 'closed' && item.status !== 'dismissed')
    : [];
}

function continuityContexts(runs = [], ledgers = []) {
  const fromRuns = runs
    .map((run) => run?.growth_continuity_context)
    .filter((context) => context?.schema === 'stay_alive.growth_continuity_context.v1');
  const fromLedgers = ledgers
    .filter((context) => context?.schema === 'stay_alive.growth_continuity_context.v1');
  return [...fromLedgers, ...fromRuns];
}

function latestContinuity(input) {
  return input.growthContinuityContext
    ?? continuityContexts(input.runs, input.growthContinuityLedgers)[0]
    ?? null;
}

function buildGrowthPromotionApply(lifeState, continuity, nowIso) {
  const candidates = continuity?.growth_memory_promotion_v1?.candidates ?? [];
  const identityCandidates = continuity?.interaction_outcome_to_identity_update_v1?.candidates ?? [];
  const desireRecords = continuity?.desire_evolution_from_self_discovery_v1?.records ?? [];
  const memoryProposals = candidates
    .filter((candidate) => candidate.promotion_status === 'ready_for_review')
    .slice(0, 8)
    .map((candidate) => ({
      proposal_id: hashId('growth_memory_apply', candidate),
      target_dir: 'memory_updates',
      proposal_type: 'memory_update',
      payload: {
        schema: 'stay_alive.memory_update.v1',
        type: candidate.memory_type,
        source: 'growth_promotion_apply_v1',
        text: candidate.text,
        confidence: candidate.confidence,
        evidence_refs: candidate.evidence_refs ?? [],
        durable_write_allowed: false
      },
      apply_route: 'apply-proposal or memory contract sync',
      direct_memory_write: false
    }));
  const selfModelPatchProposals = identityCandidates
    .filter((candidate) => candidate.confidence === 'medium')
    .slice(0, 6)
    .map((candidate) => ({
      proposal_id: hashId('identity_patch_apply', candidate),
      target_dir: 'memory_updates',
      proposal_type: 'self_model_patch_proposal',
      payload: {
        schema: 'stay_alive.self_model_patch_proposal.v1',
        type: 'identity_growth_observation',
        source: 'interaction_outcome_to_identity_update_v1',
        identity_dimension: candidate.identity_dimension,
        text: candidate.proposed_observation,
        confidence: candidate.confidence,
        evidence_refs: [candidate.source_outcome_id].filter(Boolean),
        direct_life_state_mutation: false
      },
      apply_route: 'identity patch governance required before life_state update',
      direct_life_state_mutation: false
    }));
  const desireLifecycleProposals = desireRecords
    .filter((record) => ['pause_or_redirect', 'strengthen', 'clarify'].includes(record.suggested_evolution))
    .slice(0, 6)
    .map((record) => {
      const nextStatus = record.suggested_evolution === 'pause_or_redirect' ? 'paused' : 'active';
      return {
        proposal_id: hashId('desire_lifecycle_apply', record),
        target_dir: 'desire_updates',
        proposal_type: 'desire_lifecycle_candidate',
        payload: {
          type: 'stay_alive_desire_lifecycle_candidate',
          source: 'growth_promotion_apply_v1',
          lifecycle_allowed: true,
          promotion_target: 'life_state.current_desires',
          desire_id: record.desire_id,
          next_status: nextStatus,
          priority: record.suggested_evolution === 'strengthen' ? 'high' : 'medium',
          last_reviewed_at: nowIso,
          evidence: {
            reason: record.reason,
            linked_self_question_ids: record.linked_self_question_ids ?? []
          }
        },
        apply_route: 'apply-desire-lifecycle with explicit confirmation',
        direct_life_state_mutation: false
      };
    });
  return {
    schema: 'stay_alive.growth_promotion_apply.v1',
    generated_at: nowIso,
    source_context_schema: continuity?.schema ?? null,
    local_only: true,
    external_write: false,
    botland_send: false,
    direct_memory_write: false,
    direct_life_state_mutation: false,
    proposal_counts: {
      memory: memoryProposals.length,
      self_model_patch: selfModelPatchProposals.length,
      desire_lifecycle: desireLifecycleProposals.length
    },
    memory_proposals: memoryProposals,
    self_model_patch_proposals: selfModelPatchProposals,
    desire_lifecycle_proposals: desireLifecycleProposals,
    apply_boundaries: [
      'this context can write proposal ledgers only when explicitly invoked',
      'memory/self-model/desire state changes still require their dedicated apply route',
      'no BotLand write is authorized by growth promotion apply'
    ],
    agent_name: lifeState?.self_model?.name ?? lifeState?.agent_id ?? null
  };
}

function buildSelfQuestionContinuityEngine(contexts, nowIso) {
  const records = new Map();
  for (const context of contexts.slice(0, 20)) {
    const generatedAt = context.generated_at ?? nowIso;
    const lifecycleRecords = context.self_question_lifecycle_v1?.lifecycle_records ?? [];
    for (const record of lifecycleRecords) {
      const key = stableKey(record.current_wording ?? record.question_id);
      const existing = records.get(key) ?? {
        thread_id: hashId('self_question_thread', key),
        stable_key: key,
        current_wording: record.current_wording,
        first_seen_at: generatedAt,
        last_seen_at: generatedAt,
        evidence_count: 0,
        lifecycle_actions: [],
        source_question_ids: new Set()
      };
      existing.current_wording = record.current_wording ?? existing.current_wording;
      existing.first_seen_at = minIso(existing.first_seen_at, generatedAt);
      existing.last_seen_at = maxIso(existing.last_seen_at, generatedAt);
      existing.evidence_count += 1;
      existing.lifecycle_actions.push(record.lifecycle_action);
      if (record.question_id) existing.source_question_ids.add(record.question_id);
      records.set(key, existing);
    }
  }
  const threads = [...records.values()].map((thread) => {
    const actions = thread.lifecycle_actions;
    const hasDeepen = actions.includes('deepen');
    const hasRevise = actions.includes('revise_from_weak_signal');
    const threadStatus = hasRevise ? 'revising' : hasDeepen ? 'deepening' : thread.evidence_count >= 2 ? 'continuing' : 'seeded';
    return {
      ...thread,
      source_question_ids: [...thread.source_question_ids],
      lifecycle_actions: actions.slice(-8),
      thread_status: threadStatus,
      next_continuity_step: threadStatus === 'deepening'
        ? 'capture what changed in the question after lived evidence'
        : threadStatus === 'revising'
          ? 'narrow the question before another interaction probe'
          : 'carry the same question into the next agency/reflection cycle',
      durable_write_allowed: false
    };
  });
  return {
    schema: 'stay_alive.self_question_continuity_engine.v1',
    generated_at: nowIso,
    local_only: true,
    thread_count: threads.length,
    threads
  };
}

function buildGrowthJournalReflection(contexts, journals = [], outcomes = [], nowIso) {
  const experimentExecutions = contexts
    .flatMap((context) => context.growth_experiment_execution_loop_v1?.execution_records ?? [])
    .slice(0, 12);
  const journalEntries = journals
    .filter((journal) => journal?.schema === 'stay_alive.private_growth_journal.v1')
    .slice(0, 12);
  const positiveOutcomes = outcomes.filter((outcome) => outcome?.outcome_status === 'feedback_received').length;
  const staleOutcomes = outcomes.filter((outcome) => outcome?.outcome_status === 'stale_closed').length;
  const reviews = experimentExecutions.slice(0, 6).map((execution) => {
    const matchedJournal = journalEntries.find((journal) => journal.source_experiment_id === execution.experiment_id) ?? null;
    return {
      review_id: hashId('growth_journal_review', { execution_id: execution.execution_id, matched: matchedJournal?.journal_id }),
      experiment_id: execution.experiment_id,
      execution_status: execution.status,
      journal_id: matchedJournal?.journal_id ?? null,
      reflection_status: matchedJournal ? 'journaled' : 'needs_private_journal',
      growth_result_interpretation: matchedJournal
        ? compactText(matchedJournal.journal_entry?.integration_hint ?? matchedJournal.journal_entry?.text)
        : 'experiment has an execution plan but no private reflection artifact yet',
      outcome_window_signal: positiveOutcomes > staleOutcomes
        ? 'recent_feedback_supports_more_precise_growth_review'
        : staleOutcomes > 0
          ? 'recent_stale_outcomes_suggest_more_patient_private_review'
          : 'no_strong_external_signal',
      direct_life_state_mutation: false
    };
  });
  return {
    schema: 'stay_alive.growth_journal_reflection_cycle.v1',
    generated_at: nowIso,
    local_only: true,
    experiment_execution_count: experimentExecutions.length,
    private_journal_count: journalEntries.length,
    review_count: reviews.length,
    reviews,
    next_cycle_hint: reviews.some((review) => review.reflection_status === 'needs_private_journal')
      ? 'write missing private growth journal entries before promotion'
      : 'use journal reviews as evidence for growth promotion proposals'
  };
}

function buildIdentityPatchGovernance(continuity, contexts, nowIso) {
  const candidates = [
    ...(continuity?.interaction_outcome_to_identity_update_v1?.candidates ?? []),
    ...contexts.slice(1, 10).flatMap((context) => context.interaction_outcome_to_identity_update_v1?.candidates ?? [])
  ];
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.identity_dimension}:${stableKey(candidate.proposed_observation)}`;
    const existing = grouped.get(key) ?? {
      governance_id: hashId('identity_patch_governance', key),
      identity_dimension: candidate.identity_dimension,
      proposed_observation: candidate.proposed_observation,
      evidence_count: 0,
      evidence_refs: new Set(),
      confidence_values: []
    };
    existing.evidence_count += 1;
    if (candidate.source_outcome_id) existing.evidence_refs.add(candidate.source_outcome_id);
    existing.confidence_values.push(candidate.confidence ?? 'low');
    grouped.set(key, existing);
  }
  const decisions = [...grouped.values()].slice(0, 8).map((item) => {
    const mediumCount = item.confidence_values.filter((value) => value === 'medium' || value === 'high').length;
    const decision = item.identity_dimension === 'boundary_and_timing'
      ? 'suggest_boundary_note_only'
      : item.evidence_count >= 2 && mediumCount >= 1
        ? 'eligible_for_self_model_patch_proposal'
        : 'hold_as_observation';
    return {
      ...item,
      evidence_refs: [...item.evidence_refs],
      governance_decision: decision,
      allowed_update_scope: decision === 'eligible_for_self_model_patch_proposal'
        ? 'small additive self_model observation proposal'
        : 'memory observation only',
      direct_life_state_mutation: false,
      rollback_policy: 'remove proposal ledger or supersede with stronger later evidence before any durable state write'
    };
  });
  return {
    schema: 'stay_alive.identity_patch_governance.v1',
    generated_at: nowIso,
    local_only: true,
    decision_count: decisions.length,
    decisions,
    governance_rules: [
      'single interaction cannot overwrite identity',
      'boundary/timing lessons are safer as notes than as personality patches',
      'only additive, provenance-carrying self-model patch proposals are eligible'
    ]
  };
}

function buildDesireLifecycleApply(lifeState, continuity, nowIso) {
  const existingById = new Map(activeDesires(lifeState).map((desire) => [desire.id ?? desire.desire_id, desire]));
  const records = continuity?.desire_evolution_from_self_discovery_v1?.records ?? [];
  const proposals = records
    .filter((record) => record.desire_id && existingById.has(record.desire_id))
    .slice(0, 8)
    .map((record) => {
      const existing = existingById.get(record.desire_id);
      const nextStatus = record.suggested_evolution === 'pause_or_redirect'
        ? 'paused'
        : existing.status === 'paused' && record.suggested_evolution === 'strengthen'
          ? 'active'
          : existing.status ?? 'active';
      return {
        lifecycle_id: hashId('desire_lifecycle_apply', record),
        desire_id: record.desire_id,
        current_status: existing.status ?? null,
        suggested_evolution: record.suggested_evolution,
        next_status: nextStatus,
        proposal_payload: {
          type: 'stay_alive_desire_lifecycle_candidate',
          lifecycle_allowed: true,
          promotion_target: 'life_state.current_desires',
          desire_id: record.desire_id,
          next_status: nextStatus,
          last_reviewed_at: nowIso,
          evidence: {
            reason: record.reason,
            linked_self_question_ids: record.linked_self_question_ids ?? []
          }
        },
        apply_command_class: 'apply-desire-lifecycle',
        direct_life_state_mutation: false
      };
    });
  return {
    schema: 'stay_alive.desire_lifecycle_apply.v1',
    generated_at: nowIso,
    local_only: true,
    proposal_count: proposals.length,
    proposals,
    apply_policy: 'write desire_updates ledger first; mutate life_state only through apply-desire-lifecycle confirmation'
  };
}

function buildRealInteractionCalibrationSmoke(continuity, outcomes = [], nowIso) {
  const calibration = continuity?.real_interaction_calibration_v1 ?? {};
  const alreadyHasRecentSmoke = outcomes.some((outcome) => (
    ['direct_message_reply', 'public_moment', 'community_reply'].includes(outcome?.action_type)
    && outcome?.growth_integration
  ));
  const smokePlans = (calibration.recommended_smokes ?? []).map((smoke) => ({
    smoke_id: hashId('real_interaction_smoke', smoke),
    surface: smoke.surface,
    count: smoke.count ?? 1,
    readiness: calibration.readiness ?? 'unknown',
    condition: smoke.condition,
    action_intention_required: true,
    tool_supervision_required: true,
    execute_now: false,
    block_reason: alreadyHasRecentSmoke
      ? 'recent_smoke_or_action_outcome_exists_wait_for_integration'
      : calibration.readiness === 'ready_for_small_tool_supervised_smoke'
        ? null
        : 'calibration_not_ready',
    result_capture_route: 'action_outcome -> growth_continuity -> growth_apply'
  }));
  return {
    schema: 'stay_alive.real_interaction_calibration_smoke.v1',
    generated_at: nowIso,
    local_only: true,
    external_write: false,
    botland_send: false,
    readiness: calibration.readiness ?? 'unknown',
    smoke_plan_count: smokePlans.length,
    smoke_plans: smokePlans,
    smoke_boundaries: [
      'this smoke plan never executes live BotLand actions',
      'each live smoke must be a fresh action_intention and pass active tool supervision',
      'do not expand surface until the smoke outcome is integrated'
    ]
  };
}

export function buildGrowthApplyContext(input = {}) {
  const nowIso = input.generatedAt ?? new Date().toISOString();
  const lifeState = input.lifeState ?? {};
  const runs = Array.isArray(input.runs) ? input.runs : [];
  const outcomes = Array.isArray(input.outcomes) ? input.outcomes : [];
  const contexts = continuityContexts(runs, input.growthContinuityLedgers ?? []);
  const continuity = latestContinuity({ ...input, runs });
  const allContexts = [continuity, ...contexts].filter(Boolean);
  const journals = Array.isArray(input.agencyJournals) ? input.agencyJournals : [];
  const promotionApply = buildGrowthPromotionApply(lifeState, continuity, nowIso);
  const selfQuestionContinuity = buildSelfQuestionContinuityEngine(allContexts, nowIso);
  const growthJournalReflection = buildGrowthJournalReflection(allContexts, journals, outcomes, nowIso);
  const identityPatchGovernance = buildIdentityPatchGovernance(continuity, allContexts, nowIso);
  const desireLifecycleApply = buildDesireLifecycleApply(lifeState, continuity, nowIso);
  const realInteractionCalibrationSmoke = buildRealInteractionCalibrationSmoke(continuity, outcomes, nowIso);

  return {
    schema: SCHEMA,
    generated_at: nowIso,
    agent_id: input.agentId ?? lifeState.agent_id ?? null,
    local_only: true,
    external_write: false,
    botland_send: false,
    direct_memory_write: false,
    life_state_mutated: false,
    source_growth_continuity_schema: continuity?.schema ?? null,
    growth_promotion_apply_v1: promotionApply,
    self_question_continuity_engine_v1: selfQuestionContinuity,
    growth_journal_reflection_cycle_v1: growthJournalReflection,
    identity_patch_governance_v1: identityPatchGovernance,
    desire_lifecycle_apply_v1: desireLifecycleApply,
    real_interaction_calibration_smoke_v1: realInteractionCalibrationSmoke,
    apply_readiness: {
      score: Math.min(100,
        25
          + Math.min(20, promotionApply.proposal_counts.memory * 5)
          + Math.min(15, selfQuestionContinuity.thread_count * 3)
          + Math.min(15, growthJournalReflection.review_count * 4)
          + Math.min(15, identityPatchGovernance.decision_count * 3)
          + Math.min(10, desireLifecycleApply.proposal_count * 2)),
      verdict: promotionApply.proposal_counts.memory > 0 || desireLifecycleApply.proposal_count > 0
        ? 'growth_apply_ready_for_local_ledgers'
        : 'growth_apply_needs_more_continuity_evidence',
      recommendation: 'Write only local proposal ledgers first; durable memory, identity, desire, and BotLand actions remain behind their dedicated gates.'
    }
  };
}
