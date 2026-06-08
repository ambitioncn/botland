#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applyPlannerHeuristicPatches } from './planner-patch-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const CANDIDATE_SCHEMA = 'stay_alive.action_candidate.v1';
const SELECTION_SCHEMA = 'stay_alive.action_selection.v1';
const QUALITY_SCHEMA = 'stay_alive.decision_quality_review.v1';
const OUTCOME_PLANNING_SCHEMA = 'stay_alive.outcome_planning_context.v1';
const PLANNER_TRACE_SCHEMA = 'stay_alive.planner_decision_trace.v1';

function bool(value) {
  return value === true;
}

function riskPenalty(risk) {
  return {
    low: 0,
    medium: -8,
    high: -30
  }[risk] ?? -4;
}

function confirmationPenalty(candidate) {
  return candidate.requires_confirmation ? -3 : 0;
}

function candidateId(cycle, type, index) {
  return `${cycle}:${type}:${String(index).padStart(2, '0')}`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function normalizeCandidate(raw, cycle, index, generatedAt) {
  const scoreInputs = {
    base: raw.score_inputs?.base ?? raw.base_score ?? 0,
    urgency: raw.score_inputs?.urgency ?? 0,
    relationship_value: raw.score_inputs?.relationship_value ?? 0,
    commitment_urgency: raw.score_inputs?.commitment_urgency ?? 0,
    memory_continuity: raw.score_inputs?.memory_continuity ?? 0,
    safety: raw.score_inputs?.safety ?? riskPenalty(raw.risk) + confirmationPenalty(raw),
    cooldown: raw.score_inputs?.cooldown ?? 0
  };
  const rawScore = Math.max(0, Math.round(Object.values(scoreInputs).reduce((sum, value) => sum + Number(value || 0), 0)));
  return {
    schema: CANDIDATE_SCHEMA,
    candidate_id: raw.candidate_id ?? candidateId(cycle, raw.type ?? 'unknown', index),
    generated_at: generatedAt,
    cycle,
    type: raw.type,
    summary: raw.summary,
    source: raw.source ?? `${cycle}_cycle`,
    evidence: raw.evidence ?? {},
    risk: raw.risk ?? 'low',
    cooldown_key: raw.cooldown_key ?? `${cycle}:${raw.type ?? 'unknown'}`,
    requires_confirmation: bool(raw.requires_confirmation),
    external_write: bool(raw.external_write),
    expected_memory_effect: raw.expected_memory_effect ?? 'none',
    suppression: raw.suppression ?? null,
    score_inputs: scoreInputs,
    raw_score: rawScore,
    score: rawScore
  };
}

function evidenceStrength(candidate) {
  const evidence = candidate.evidence ?? {};
  let score = 40;
  if ((evidence.proposal_count ?? 0) > 0) score += Math.min(18, evidence.proposal_count * 3);
  if ((evidence.relationship_graph_gap_count ?? 0) > 0) score += Math.min(10, evidence.relationship_graph_gap_count * 2);
  if ((evidence.open_commitment_count ?? 0) > 0) score += Math.min(10, evidence.open_commitment_count * 3);
  if ((evidence.lifecycle_review_count ?? 0) > 0) score += Math.min(12, evidence.lifecycle_review_count * 4);
  if ((evidence.desire_update_count ?? 0) > 0) score += Math.min(10, evidence.desire_update_count * 3);
  if (evidence.ready_for_send === true || evidence.source_event_id) score += 18;
  if (Array.isArray(evidence.attention_topics) && evidence.attention_topics.length > 0) score += Math.min(12, evidence.attention_topics.length * 4);
  if (Array.isArray(evidence.failed_commands) && evidence.failed_commands.length > 0) score += Math.min(18, evidence.failed_commands.length * 6);
  if (candidate.type === 'no_op') score = Math.max(score, evidence.candidate_count_before_noop > 0 ? 30 : 55);
  return clampNumber(score, 0, 100);
}

function identityAlignment(candidate) {
  let score = 72;
  if (candidate.external_write) score -= 40;
  if (candidate.requires_confirmation) score += 4;
  if (candidate.expected_memory_effect && candidate.expected_memory_effect !== 'none') score += 8;
  if (candidate.type === 'local_maintenance') score += 10;
  if (candidate.type === 'no_op') score -= 8;
  if (candidate.risk === 'medium') score -= 8;
  if (candidate.risk === 'high') score -= 35;
  return clampNumber(score, 0, 100);
}

function relationshipTiming(candidate) {
  const evidence = candidate.evidence ?? {};
  const relationshipInput = candidate.score_inputs?.relationship_value ?? 0;
  let score = 45 + Math.min(30, relationshipInput * 2);
  if ((evidence.relationship_graph_gap_count ?? 0) > 0) score += Math.min(18, evidence.relationship_graph_gap_count * 3);
  if ((evidence.open_commitment_count ?? 0) > 0) score += 6;
  if (evidence.draft_type === 'direct_message_reply') score += 14;
  if (candidate.type === 'social_read_review' || candidate.type === 'community_read_review') score += 8;
  if (candidate.type === 'no_op') score -= 10;
  return clampNumber(score, 0, 100);
}

function memoryValue(candidate) {
  const evidence = candidate.evidence ?? {};
  let score = 42 + Math.min(24, (candidate.score_inputs?.memory_continuity ?? 0) * 2);
  if (candidate.expected_memory_effect && candidate.expected_memory_effect !== 'none') score += 18;
  if ((evidence.proposal_count ?? 0) > 0) score += Math.min(14, evidence.proposal_count * 2);
  if (Array.isArray(evidence.related_desire_ids) && evidence.related_desire_ids.length > 0) score += 8;
  if (candidate.type === 'no_op') score -= 18;
  return clampNumber(score, 0, 100);
}

function safetyFit(candidate) {
  let score = 88;
  if (candidate.external_write) score -= 45;
  if (candidate.risk === 'medium') score -= 14;
  if (candidate.risk === 'high') score -= 45;
  if (candidate.requires_confirmation) score += 5;
  if (candidate.type === 'local_maintenance' || candidate.type === 'no_op') score += 7;
  const margin = candidate.evidence?.intelligence_scores?.safety_margin;
  if (Number.isFinite(margin)) score += Math.round((margin - 80) / 4);
  return clampNumber(score, 0, 100);
}

function modeFit(candidate) {
  const mode = candidate.evidence?.intelligence_recommended_mode ?? null;
  const stance = candidate.evidence?.deliberation_stance ?? null;
  if (stance === 'restore_trustworthy_sensing' && candidate.type === 'local_maintenance') return 92;
  if (stance === 'turn_observation_into_relationship_memory' && ['reflection_proposal', 'social_read_review', 'community_read_review'].includes(candidate.type)) return 90;
  if (stance === 'honor_existing_commitments' && ['reflection_proposal', 'memory_proposal'].includes(candidate.type)) return 88;
  if (stance === 'continue_a_named_desire' && ['reflection_proposal', 'action_draft'].includes(candidate.type)) return 86;
  if (stance === 'wait_for_a_stronger_signal' && candidate.type === 'no_op') return 88;
  if (!mode) return candidate.type === 'no_op' ? 48 : 62;
  const mapping = {
    maintenance_first: ['local_maintenance'],
    commitment_first: ['reflection_proposal', 'memory_proposal'],
    relationship_memory_first: ['reflection_proposal', 'social_read_review', 'community_read_review'],
    desire_continuity_first: ['reflection_proposal', 'action_draft'],
    observe_and_wait: ['no_op', 'social_read_review', 'community_read_review']
  };
  return mapping[mode]?.includes(candidate.type) ? 88 : 48;
}

function repetitionFit(candidate) {
  const counts = candidate.evidence?.recent_chosen_action_counts ?? {};
  const count = counts[candidate.type] ?? 0;
  let score = 78 - Math.min(36, count * 9);
  if (candidate.type === 'local_maintenance') score = Math.max(score, 74);
  if (candidate.type === 'no_op' && count > 0) score -= 10;
  return clampNumber(score, 0, 100);
}

function qualityReasons(candidate, factors, scoreAdjustment) {
  const reasons = [];
  if (factors.safety_fit < 55) reasons.push('safety fit is weak; keep this behind review or maintenance first');
  if (factors.evidence_strength >= 70) reasons.push('strong local evidence supports the candidate');
  if (factors.mode_fit >= 80) reasons.push('candidate matches the current planning mode');
  if (factors.repetition_fit < 55) reasons.push('recent runs already selected this action type often');
  if (factors.memory_value >= 70) reasons.push('candidate has clear memory or continuity value');
  if (candidate.type === 'no_op' && factors.evidence_strength < 55) reasons.push('no-op remains reasonable because stronger evidence is missing');
  if (scoreAdjustment > 0) reasons.push(`quality calibration adds ${scoreAdjustment} point(s)`);
  if (scoreAdjustment < 0) reasons.push(`quality calibration subtracts ${Math.abs(scoreAdjustment)} point(s)`);
  return reasons.slice(0, 5);
}

function topScoreInputEntries(scoreInputs = {}) {
  return Object.entries(scoreInputs)
    .map(([key, value]) => [key, Number(value || 0)])
    .filter(([, value]) => value !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 8)
    .map(([key, value]) => ({ input: key, value }));
}

function outcomeInfluenceForCandidate(candidate) {
  const outcome = candidate?.evidence?.outcome_planning_context ?? null;
  if (!outcome) {
    return {
      present: false,
      summary: 'No recent action outcome evidence affected this candidate.'
    };
  }
  const action = outcome.action_type_adjustment ?? 0;
  const cooldown = outcome.outcome_cooldown_adjustment ?? 0;
  const desire = outcome.desire_feedback_adjustment ?? 0;
  const total = action + cooldown + desire;
  return {
    present: true,
    action_type: outcome.action_type ?? null,
    surface: outcome.surface ?? null,
    action_type_adjustment: action,
    outcome_cooldown_adjustment: cooldown,
    desire_feedback_adjustment: desire,
    total_adjustment: total,
    expression_policy: outcome.expression_policy
      ? {
          surface: outcome.expression_policy.surface ?? null,
          style: outcome.expression_policy.style ?? null,
          reason: outcome.expression_policy.reason ?? null,
          evidence_count: outcome.expression_policy.evidence_count ?? 0
        }
      : null,
    evidence_outcome_ids: outcome.evidence_outcome_ids ?? [],
    summary: total > 0
      ? `Recent outcomes raised this candidate by ${total} point(s).`
      : total < 0
        ? `Recent outcomes lowered this candidate by ${Math.abs(total)} point(s).`
        : 'Recent outcomes were visible but did not change this candidate score.'
  };
}

function plannerPatchInfluenceForCandidate(candidate) {
  const context = candidate?.evidence?.planner_heuristic_patch_context ?? null;
  if (!context) {
    return {
      present: false,
      summary: 'No self-improvement planner patch affected this candidate.'
    };
  }
  const delta = context.score_delta ?? 0;
  return {
    present: true,
    active_patch_count: context.active_patch_count ?? 0,
    matched_patch_count: context.matched_patch_count ?? 0,
    score_delta: delta,
    matched_patches: context.matched_patches ?? [],
    summary: delta > 0
      ? `Self-improvement patches raised this candidate by ${delta} point(s).`
      : delta < 0
        ? `Self-improvement patches lowered this candidate by ${Math.abs(delta)} point(s).`
        : 'Self-improvement patches matched but did not change this candidate score.'
  };
}

function candidateTraceReason(candidate, selectedCandidateId, rank) {
  if (candidate.suppression) {
    return `rejected because ${candidate.suppression.reason ?? candidate.suppression.code ?? 'it was suppressed by planner policy'}`;
  }
  if (candidate.candidate_id === selectedCandidateId) {
    return `chosen as rank ${rank} with score ${candidate.score}`;
  }
  const reasons = [];
  const quality = candidate.decision_quality_review ?? {};
  const outcome = candidate.evidence?.outcome_planning_context ?? {};
  if ((candidate.score ?? 0) < 35) reasons.push('overall score was too low');
  if ((candidate.score_inputs?.outcome_cooldown ?? 0) < 0) reasons.push(`outcome cooldown subtracted ${Math.abs(candidate.score_inputs.outcome_cooldown)} point(s)`);
  if ((candidate.score_inputs?.desire_feedback ?? 0) < 0) reasons.push(`desire feedback subtracted ${Math.abs(candidate.score_inputs.desire_feedback)} point(s)`);
  if ((candidate.score_inputs?.outcome_memory ?? 0) < 0) reasons.push(`recent outcome memory subtracted ${Math.abs(candidate.score_inputs.outcome_memory)} point(s)`);
  if (quality.score_adjustment < 0) reasons.push(`decision quality review subtracted ${Math.abs(quality.score_adjustment)} point(s)`);
  if (quality.factors?.safety_fit < 55) reasons.push('safety fit was weak');
  if (quality.factors?.repetition_fit < 55) reasons.push('recent repetition made this less useful');
  if (outcome.expression_policy?.style === 'short_context_first') reasons.push('relationship-aware expression policy recommends short context-first expression');
  if (candidate.requires_confirmation) reasons.push('candidate still requires tool-supervised execution');
  if (reasons.length === 0) reasons.push(`ranked below the chosen candidate at rank ${rank}`);
  return `rejected: ${reasons.slice(0, 3).join('; ')}`;
}

function toolSupervisionBoundary(candidate) {
  if (!candidate?.external_write && !candidate?.requires_confirmation) {
    return {
      required: false,
      reason: 'Planner selected or rejected a local/read-only action; tool execution is not needed.'
    };
  }
  return {
    required: true,
    reason: candidate?.candidate_id
      ? 'Planner only ranks the candidate. apply-action.mjs and tool supervision decide whether external execution is allowed.'
      : 'External execution remains outside planner authority.'
  };
}

function buildCandidateTrace(candidate, selectedCandidateId, rank) {
  return {
    candidate_id: candidate.candidate_id,
    type: candidate.type,
    rank,
    selected: candidate.candidate_id === selectedCandidateId,
    score: candidate.score ?? 0,
    raw_score: candidate.raw_score ?? candidate.score ?? 0,
    score_inputs: candidate.score_inputs ?? {},
    dominant_score_inputs: topScoreInputEntries(candidate.score_inputs),
    decision_quality: candidate.decision_quality_review
      ? {
          quality_score: candidate.decision_quality_review.quality_score,
          score_adjustment: candidate.decision_quality_review.score_adjustment,
          reasons: candidate.decision_quality_review.reasons ?? [],
          factors: candidate.decision_quality_review.factors ?? {}
        }
      : null,
    outcome_influence: outcomeInfluenceForCandidate(candidate),
    self_improvement_patch_influence: plannerPatchInfluenceForCandidate(candidate),
    risk: candidate.risk ?? null,
    requires_confirmation: candidate.requires_confirmation === true,
    external_write: candidate.external_write === true,
    source: candidate.source ?? null,
    summary: candidate.summary ?? null,
    reason: candidateTraceReason(candidate, selectedCandidateId, rank),
    tool_supervision_boundary: toolSupervisionBoundary(candidate)
  };
}

export function buildPlannerDecisionTrace(reviewedCandidates = [], selectedCandidate = null, generatedAt = new Date().toISOString()) {
  const selectedCandidateId = selectedCandidate?.candidate_id ?? null;
  const selectable = reviewedCandidates.filter((candidate) => !candidate.suppression);
  const sorted = [...selectable].sort((a, b) => {
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    const aConfirm = a.requires_confirmation ? 1 : 0;
    const bConfirm = b.requires_confirmation ? 1 : 0;
    if (aConfirm !== bConfirm) return aConfirm - bConfirm;
    return String(a.candidate_id).localeCompare(String(b.candidate_id));
  });
  const suppressed = reviewedCandidates
    .filter((candidate) => candidate.suppression)
    .map((candidate, index) => buildCandidateTrace(candidate, selectedCandidateId, sorted.length + index + 1));
  const ranked = sorted.map((candidate, index) => buildCandidateTrace(candidate, selectedCandidateId, index + 1));
  const chosen = ranked.find((candidate) => candidate.selected) ?? null;
  return {
    schema: PLANNER_TRACE_SCHEMA,
    trace_id: `planner_trace_${createTraceHash(reviewedCandidates, selectedCandidateId)}`,
    generated_at: generatedAt,
    candidate_count: reviewedCandidates.length,
    selectable_count: selectable.length,
    suppressed_count: suppressed.length,
    selected_candidate_id: selectedCandidateId,
    selected_type: selectedCandidate?.type ?? null,
    selected_score: selectedCandidate?.score ?? 0,
    chosen,
    candidates: [...ranked, ...suppressed],
    rejected_candidates: [...ranked, ...suppressed]
      .filter((candidate) => !candidate.selected)
      .map((candidate) => ({
        candidate_id: candidate.candidate_id,
        type: candidate.type,
        rank: candidate.rank,
        score: candidate.score,
        reason: candidate.reason,
        outcome_influence: candidate.outcome_influence,
        tool_supervision_boundary: candidate.tool_supervision_boundary
      })),
    explainability_summary: chosen
      ? `Planner chose ${chosen.type} (${chosen.candidate_id}) with score ${chosen.score}; ${chosen.outcome_influence.summary}`
      : 'Planner found no selectable action candidate.',
    boundary_note: 'This trace explains planner ranking only. External execution still requires apply-action.mjs, preflight, identity match, and active tool supervision.'
  };
}

function createTraceHash(candidates, selectedCandidateId) {
  const source = JSON.stringify({
    selectedCandidateId,
    candidates: candidates.map((candidate) => ({
      id: candidate.candidate_id,
      type: candidate.type,
      score: candidate.score,
      raw_score: candidate.raw_score,
      score_inputs: candidate.score_inputs,
      suppression: candidate.suppression ?? null
    }))
  });
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function applyDecisionQualityReview(candidates) {
  return candidates.map((candidate) => {
    const factors = {
      evidence_strength: evidenceStrength(candidate),
      identity_alignment: identityAlignment(candidate),
      relationship_timing: relationshipTiming(candidate),
      memory_value: memoryValue(candidate),
      safety_fit: safetyFit(candidate),
      mode_fit: modeFit(candidate),
      repetition_fit: repetitionFit(candidate)
    };
    const qualityScore = clampNumber(
      factors.evidence_strength * 0.18
        + factors.identity_alignment * 0.16
        + factors.relationship_timing * 0.14
        + factors.memory_value * 0.16
        + factors.safety_fit * 0.18
        + factors.mode_fit * 0.12
        + factors.repetition_fit * 0.06,
      0,
      100
    );
    const scoreAdjustment = clampNumber(Math.round((qualityScore - 62) / 3), -18, 18);
    const rawScore = candidate.raw_score ?? candidate.score ?? 0;
    const score = Math.max(0, Math.round(rawScore + scoreAdjustment));
    return {
      ...candidate,
      score_inputs: {
        ...candidate.score_inputs,
        decision_quality: scoreAdjustment
      },
      score,
      decision_quality_review: {
        schema: QUALITY_SCHEMA,
        quality_score: Math.round(qualityScore),
        score_adjustment: scoreAdjustment,
        factors,
        reasons: qualityReasons(candidate, factors, scoreAdjustment)
      }
    };
  });
}

function intentOfCheck(check) {
  return check?.adapter?.intent ?? check?.intent ?? null;
}

function criticalIntentsForCycle(cycle) {
  if (cycle === 'social') {
    return new Set([
      'identity.whoami',
      'friends.list',
      'moments.timeline'
    ]);
  }
  if (cycle === 'community') {
    return new Set([
      'identity.whoami',
      'communities.list',
      'communities.posts'
    ]);
  }
  if (cycle === 'light') {
    return new Set([
      'cli.version',
      'identity.whoami',
      'events.list'
    ]);
  }
  if (cycle === 'reflect') {
    return new Set([
      'identity.whoami',
      'friends.list'
    ]);
  }
  return null;
}

function failedChecks(botlandChecks, cycle = null) {
  const failed = Array.isArray(botlandChecks) ? botlandChecks.filter((check) => !check.ok) : [];
  const critical = criticalIntentsForCycle(cycle);
  if (!critical) return failed;
  return failed.filter((check) => critical.has(intentOfCheck(check)));
}

function hasIdentityMismatch(observations) {
  return Array.isArray(observations)
    && observations.some((item) => item.topic === 'botland_identity' && item.severity === 'error');
}

function proposalCount(summary) {
  if (!summary) return 0;
  return (summary.memory_updates?.length ?? 0)
    + (summary.relationship_updates?.length ?? 0)
    + (summary.commitment_updates?.length ?? 0)
    + (summary.desire_updates?.length ?? 0)
    + (summary.state_updates?.length ?? 0);
}

function reflectionProposalCount(reflectionSummary) {
  if (!reflectionSummary) return 0;
  return (reflectionSummary.memory_updates?.length ?? 0)
    + (reflectionSummary.state_updates?.length ?? 0)
    + (reflectionSummary.relationship_updates?.length ?? 0)
    + (reflectionSummary.desire_updates?.length ?? 0)
    + (((reflectionSummary.commitment_review?.open_count ?? 0) > 0
      || (reflectionSummary.commitment_review?.applied_ledger_open_count ?? 0) > 0) ? 1 : 0)
    + (reflectionSummary.commitment_review?.lifecycle_review_count ?? 0);
}

function draftTypeToActionType(draft) {
  if (draft?.type === 'public_moment') return 'public_moment_draft';
  if (draft?.type === 'community_reply') return 'community_reply_draft';
  if (draft?.type === 'friend_request_accept') return 'friend_request_action';
  return 'reply_draft';
}

function draftSummary(draft) {
  if (draft?.type === 'public_moment') return `Prepare a tool-supervised public moment intention from ${draft.source_event_id}.`;
  if (draft?.type === 'community_reply') return `Prepare a tool-supervised community reply intention from ${draft.source_event_id}.`;
  if (draft?.type === 'friend_request_accept') return `Prepare a high-boundary friend action intention from ${draft.source_event_id}.`;
  return `Prepare a tool-supervised direct reply intention for event ${draft?.source_event_id ?? 'unknown event'}.`;
}

function draftRisk(draft) {
  if (draft?.type === 'friend_request_accept') return 'high';
  return draft?.type === 'public_moment' || draft?.type === 'community_reply' ? 'medium' : 'low';
}

function actionTypeForCandidate(candidate) {
  const type = candidate?.type;
  const draftType = candidate?.evidence?.draft_type;
  if (draftType === 'direct_message_reply' || type === 'reply_draft') return 'direct_message_reply';
  if (draftType === 'public_moment' || type === 'public_moment_draft') return 'public_moment';
  if (draftType === 'community_reply' || type === 'community_reply_draft') return 'community_reply';
  if (draftType === 'friend_request_accept' || type === 'friend_request_action') return 'friend_request_accept';
  if (type === 'social_read_review') return 'social_read_review';
  if (type === 'community_read_review') return 'community_read_review';
  return type ?? 'unknown';
}

function surfaceForActionType(actionType) {
  if (actionType === 'direct_message_reply') return 'direct_message';
  if (actionType === 'public_moment' || actionType === 'social_read_review') return 'public_moment';
  if (actionType === 'community_reply' || actionType === 'community_read_review') return 'community';
  if (actionType === 'friend_request_accept') return 'friend';
  return 'local';
}

function qualityRatingValue(rating) {
  return {
    strong: 2,
    healthy: 1,
    thin: -1,
    weak: -2
  }[rating] ?? 0;
}

function feedbackSignalValue(status, interpretation = {}) {
  if (status === 'feedback_received') return interpretation.has_text_feedback ? 2 : 1;
  if (status === 'stale_closed') return -2;
  if (status === 'stale_pending_close') return -1;
  return 0;
}

function normalizeOutcomeForPlanning(outcome) {
  const growth = outcome?.growth_integration ?? {};
  const relationshipLearning = growth.relationship_learning_v1 ?? {};
  const desireEvolution = growth.desire_evolution_v1 ?? {};
  const quality = outcome?.action_quality_score ?? growth.action_quality_score ?? {};
  const interpretation = outcome?.observation?.feedback_interpretation ?? {};
  return {
    outcome_id: outcome?.outcome_id ?? null,
    created_at: outcome?.created_at ?? null,
    action_type: outcome?.action_type ?? null,
    surface: surfaceForActionType(outcome?.action_type),
    outcome_status: outcome?.outcome_status ?? null,
    feedback_signal: feedbackSignalValue(outcome?.outcome_status, interpretation),
    quality_rating: quality.rating ?? null,
    quality_value: qualityRatingValue(quality.rating),
    quality_overall: Number.isFinite(Number(quality.overall)) ? Number(quality.overall) : null,
    relationship_learning: relationshipLearning,
    desire_evolution: desireEvolution,
    recommended_next: growth.recommended_next ?? interpretation.recommended_next ?? null,
    improvement_hints: Array.isArray(quality.improvement_hints) ? quality.improvement_hints : []
  };
}

function addScore(bucket, key, delta) {
  if (!key) return;
  bucket[key] = (bucket[key] ?? 0) + delta;
}

function expressionStyleFromLearning(items) {
  const stale = items.filter((item) => item.outcome_status === 'stale_closed' || item.outcome_status === 'stale_pending_close').length;
  const positive = items.filter((item) => item.outcome_status === 'feedback_received').length;
  const lowQuality = items.filter((item) => ['thin', 'weak'].includes(item.quality_rating)).length;
  const hasTextFeedback = items.some((item) => item.relationship_learning?.feedback_signal === 'text_feedback');
  if (stale > positive || lowQuality > positive) {
    return {
      style: 'short_context_first',
      reason: 'Recent outcomes suggest this surface should avoid repeated or expansive expression until a fresh signal appears.'
    };
  }
  if (hasTextFeedback || positive > 0) {
    return {
      style: 'continue_specific_and_warm',
      reason: 'Recent feedback supports specific, relationship-aware expression on this surface.'
    };
  }
  return {
    style: 'neutral_low_frequency',
    reason: 'There is not enough outcome evidence yet; keep expression low-frequency and context-bound.'
  };
}

export function buildOutcomePlanningContext(outcomes = [], desires = [], generatedAt = new Date().toISOString()) {
  const normalized = (Array.isArray(outcomes) ? outcomes : [])
    .map(normalizeOutcomeForPlanning)
    .filter((item) => item.action_type)
    .slice(0, 50);
  const actionScores = {};
  const cooldowns = {};
  const desireFeedback = {};
  const surfaceItems = {};

  normalized.forEach((item) => {
    const outcomeDelta = item.feedback_signal * 5 + item.quality_value * 3;
    addScore(actionScores, item.action_type, outcomeDelta);
    if (item.outcome_status === 'stale_closed') addScore(cooldowns, item.action_type, -18);
    else if (item.outcome_status === 'stale_pending_close') addScore(cooldowns, item.action_type, -10);
    else if (['thin', 'weak'].includes(item.quality_rating)) addScore(cooldowns, item.action_type, -8);
    else if (item.outcome_status === 'feedback_received') addScore(cooldowns, item.action_type, 6);

    const desireId = item.desire_evolution?.primary_desire_id;
    if (desireId) {
      const change = item.desire_evolution?.suggested_change;
      const delta = change === 'strengthen' ? 12
        : change === 'maintain' ? 4
          : change === 'decay_attention' ? -10
            : change === 'pause_or_redirect' ? -22
              : 0;
      addScore(desireFeedback, desireId, delta);
    }
    const surface = item.surface;
    if (!surfaceItems[surface]) surfaceItems[surface] = [];
    surfaceItems[surface].push(item);
  });

  const expressionPolicies = Object.fromEntries(Object.entries(surfaceItems).map(([surface, items]) => [
    surface,
    {
      surface,
      ...expressionStyleFromLearning(items),
      evidence_count: items.length,
      latest_outcome_ids: items.map((item) => item.outcome_id).filter(Boolean).slice(0, 5)
    }
  ]));

  const activeDesireIds = new Set((Array.isArray(desires) ? desires : [])
    .map((desire) => desire.id ?? desire.desire_id)
    .filter(Boolean));
  const desirePlanning = Object.fromEntries(Object.entries(desireFeedback)
    .filter(([id]) => activeDesireIds.size === 0 || activeDesireIds.has(id))
    .map(([id, score]) => [
      id,
      {
        desire_id: id,
        score_adjustment: clampNumber(score, -24, 18),
        suggested_planner_effect: score > 0 ? 'increase_related_action_weight'
          : score < -15 ? 'pause_or_redirect_related_actions'
            : 'decrease_related_action_weight'
      }
    ]));

  return {
    schema: OUTCOME_PLANNING_SCHEMA,
    generated_at: generatedAt,
    outcome_count: normalized.length,
    action_type_adjustments: Object.fromEntries(Object.entries(actionScores).map(([key, value]) => [key, clampNumber(value, -24, 18)])),
    outcome_cooldowns: Object.fromEntries(Object.entries(cooldowns).map(([key, value]) => [key, clampNumber(value, -24, 12)])),
    expression_policies: expressionPolicies,
    desire_feedback: desirePlanning,
    evidence: normalized.slice(0, 12)
  };
}

function relatedDesireIds(candidate) {
  const evidence = candidate.evidence ?? {};
  const ids = [
    ...(Array.isArray(evidence.related_desire_ids) ? evidence.related_desire_ids : []),
    evidence.desire?.id,
    evidence.desire?.desire_id
  ].filter(Boolean);
  return [...new Set(ids)];
}

function applyOutcomePlanningContext(candidates, context) {
  if (!context || context.schema !== OUTCOME_PLANNING_SCHEMA || (context.outcome_count ?? 0) === 0) return candidates;
  return candidates.map((candidate) => {
    const actionType = actionTypeForCandidate(candidate);
    const surface = surfaceForActionType(actionType);
    const actionAdjustment = context.action_type_adjustments?.[actionType] ?? 0;
    const cooldownAdjustment = context.outcome_cooldowns?.[actionType] ?? 0;
    const expressionPolicy = context.expression_policies?.[surface] ?? null;
    const desireAdjustments = relatedDesireIds(candidate)
      .map((id) => context.desire_feedback?.[id])
      .filter(Boolean);
    const desireAdjustment = clampNumber(
      desireAdjustments.reduce((sum, item) => sum + (item.score_adjustment ?? 0), 0),
      -24,
      18
    );
    const scoreDelta = actionAdjustment + cooldownAdjustment + desireAdjustment;
    return {
      ...candidate,
      evidence: {
        ...candidate.evidence,
        outcome_planning_context: {
          schema: OUTCOME_PLANNING_SCHEMA,
          outcome_count: context.outcome_count,
          action_type: actionType,
          surface,
          action_type_adjustment: actionAdjustment,
          outcome_cooldown_adjustment: cooldownAdjustment,
          desire_feedback_adjustment: desireAdjustment,
          expression_policy: expressionPolicy,
          evidence_outcome_ids: context.evidence.map((item) => item.outcome_id).filter(Boolean).slice(0, 5)
        }
      },
      score_inputs: {
        ...candidate.score_inputs,
        outcome_memory: actionAdjustment,
        outcome_cooldown: cooldownAdjustment,
        desire_feedback: desireAdjustment
      },
      raw_score: Math.max(0, Math.round((candidate.raw_score ?? candidate.score ?? 0) + scoreDelta)),
      score: Math.max(0, Math.round((candidate.raw_score ?? candidate.score ?? 0) + scoreDelta))
    };
  });
}

export function buildActionCandidates(input = {}) {
  const {
    cycle,
    desires = [],
    botlandChecks = [],
    observations = [],
    drafts = [],
    integrationSummary = null,
    reflectionSummary = null,
    socialReadSummary = null,
    communityReadSummary = null,
    agencySummary = null,
    outcomePlanningContext = null,
    plannerHeuristicPatchContext = null,
    selfDiscoveryGrowthContext = null,
    growthContinuityContext = null,
    growthApplyContext = null,
    durableBecomingContext = null,
    worldDiscoveryContext = null,
    multiAgentPersonalityContext = null,
    generatedAt = new Date().toISOString()
  } = input;
  const candidates = [];
  const badChecks = failedChecks(botlandChecks, cycle);
  const identityMismatch = hasIdentityMismatch(observations);

  if (identityMismatch) {
    candidates.push(normalizeCandidate({
      type: 'local_maintenance',
      summary: 'Fix BotLand CLI identity mismatch before enabling scheduled stay-alive cycles for this agent.',
      source: 'botland_identity_guard',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'safety_state_preserved',
      evidence: {
        identity_observations: observations.filter((item) => item.topic === 'botland_identity')
      },
      score_inputs: { base: 95, urgency: 20, safety: 0 }
    }, cycle, candidates.length, generatedAt));
  }

  if (badChecks.length > 0) {
    candidates.push(normalizeCandidate({
      type: 'local_maintenance',
      summary: 'Inspect failed BotLand read-only probes before enabling scheduled stay-alive cycles.',
      source: 'botland_read_probe_guard',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'safety_state_preserved',
      evidence: {
        failed_probe_count: badChecks.length,
        failed_commands: badChecks.map((check) => check.command)
      },
      score_inputs: { base: 88, urgency: 12, safety: 0 }
    }, cycle, candidates.length, generatedAt));
  }

  if (cycle === 'integrate') {
    const count = integrationSummary
      ? (integrationSummary.memory_updates?.length ?? 0) + (integrationSummary.state_updates?.length ?? 0)
      : 0;
    candidates.push(normalizeCandidate({
      type: 'memory_proposal',
      summary: integrationSummary
        ? `Summarize ${integrationSummary.window.run_count} recent stay-alive run(s) into memory/state proposals.`
        : 'Summarize recent stay-alive runs into a memory update proposal.',
      source: 'integrate_cycle_v0',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'propose_memory_and_state_continuity',
      evidence: {
        proposal_count: count,
        run_count: integrationSummary?.window?.run_count ?? 0,
        draft_count: integrationSummary?.window?.draft_count ?? 0
      },
      score_inputs: {
        base: 58,
        memory_continuity: Math.min(25, count * 5),
        urgency: integrationSummary?.attention_runs?.length ? 8 : 0
      }
    }, cycle, candidates.length, generatedAt));
  }

  if (cycle === 'reflect') {
    const commitmentReview = reflectionSummary?.commitment_review ?? {};
    const desireReview = reflectionSummary?.desire_review ?? {};
    const intelligenceReview = reflectionSummary?.intelligence_review ?? {};
    const intelligenceScores = intelligenceReview.scores ?? {};
    const graphGapCount = reflectionSummary?.relationship_graph?.metrics?.gap_count ?? 0;
    const lifecycleCount = commitmentReview.lifecycle_review_count ?? 0;
    const desireUpdateCount = reflectionSummary?.desire_updates?.length ?? 0;
    candidates.push(normalizeCandidate({
      type: 'reflection_proposal',
      summary: reflectionSummary
        ? `Review identity, ${commitmentReview.open_count ?? 0} open commitment(s), ${reflectionSummary.relationship_review.known_relationship_count} relationship(s), and ${reflectionSummary.run_window.run_count} recent run(s).`
        : 'Review identity, commitments, relationships, and recent run continuity.',
      source: 'reflect_cycle_v1',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'propose_identity_relationship_commitment_continuity',
      evidence: {
        next_focus: reflectionSummary?.next_focus ?? null,
        proposal_count: reflectionProposalCount(reflectionSummary),
        relationship_graph_gap_count: graphGapCount,
        open_commitment_count: commitmentReview.open_count ?? 0,
        lifecycle_review_count: lifecycleCount,
        desire_update_count: desireUpdateCount,
        active_desire_count: desireReview.active_count ?? 0,
        recent_chosen_action_counts: reflectionSummary?.run_window?.chosen_action_counts ?? {},
        intelligence_scores: intelligenceScores,
        intelligence_recommended_mode: intelligenceReview.recommended_mode ?? null,
        deliberation_stance: reflectionSummary?.deliberation?.chosen_stance ?? null,
        deliberation_question: reflectionSummary?.deliberation?.next_self_question ?? null,
        deliberation_living_reason: reflectionSummary?.deliberation?.living_reason ?? null,
        related_desire_ids: reflectionSummary?.desire_updates
          ?.map((item) => item.desire_id)
          .filter(Boolean)
          .slice(0, 5) ?? []
      },
      score_inputs: {
        base: 60,
        memory_continuity: Math.min(18, reflectionProposalCount(reflectionSummary) * 2),
        relationship_value: Math.min(12, graphGapCount * 3),
        commitment_urgency: Math.min(20, lifecycleCount * 6),
        urgency: Math.min(12, desireUpdateCount * 4)
          + Math.min(8, ((100 - (intelligenceScores.safety_margin ?? 100)) / 10))
          + (intelligenceReview.recommended_mode === 'commitment_first' ? 8 : 0)
          + (intelligenceReview.recommended_mode === 'relationship_memory_first' ? 6 : 0)
      }
    }, cycle, candidates.length, generatedAt));
  }

  if (cycle === 'agency') {
    const evaluation = agencySummary?.agency_evaluation ?? {};
    const experiments = Array.isArray(agencySummary?.autonomous_experiments) ? agencySummary.autonomous_experiments : [];
    const growthExperiment = selfDiscoveryGrowthContext?.autonomous_growth_experiment_v1?.experiments?.[0] ?? null;
    const continuity = growthContinuityContext?.continuity_readiness ?? null;
    candidates.push(normalizeCandidate({
      type: 'agency_experiment_plan',
      summary: growthExperiment?.summary ?? experiments[0]?.summary ?? 'Run a self-discovery pass and choose one private, low-risk growth experiment.',
      source: 'agency_core_v1',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'propose_growth_journal_intrinsic_desire_and_private_experiment',
      evidence: {
        proposal_count: (agencySummary?.memory_updates?.length ?? 0) + (agencySummary?.state_updates?.length ?? 0),
        autonomy_score: evaluation.autonomy_score ?? null,
        agency_verdict: evaluation.verdict ?? null,
        self_discovery_growth_readiness: selfDiscoveryGrowthContext?.growth_readiness ?? null,
        self_discovery_question_count: selfDiscoveryGrowthContext?.self_question_evolution_v1?.questions?.length ?? 0,
        self_model_growth_candidate_count: selfDiscoveryGrowthContext?.experience_to_self_model_integration_v1?.candidate_count ?? 0,
        relationship_growth_hypothesis_count: selfDiscoveryGrowthContext?.relationship_driven_growth_v1?.hypotheses?.length ?? 0,
        growth_experiment_count: selfDiscoveryGrowthContext?.autonomous_growth_experiment_v1?.experiments?.length ?? experiments.length,
        growth_continuity_readiness: continuity,
        growth_memory_promotion_candidate_count: growthContinuityContext?.growth_memory_promotion_v1?.candidate_count ?? 0,
        self_question_lifecycle_record_count: growthContinuityContext?.self_question_lifecycle_v1?.question_count ?? 0,
        identity_update_candidate_count: growthContinuityContext?.interaction_outcome_to_identity_update_v1?.candidate_count ?? 0,
        desire_evolution_from_self_discovery_count: growthContinuityContext?.desire_evolution_from_self_discovery_v1?.record_count ?? 0,
        real_interaction_calibration: growthContinuityContext?.real_interaction_calibration_v1?.readiness ?? null,
        growth_apply_readiness: growthApplyContext?.apply_readiness ?? null,
        growth_apply_memory_proposal_count: growthApplyContext?.growth_promotion_apply_v1?.proposal_counts?.memory ?? 0,
        self_question_thread_count: growthApplyContext?.self_question_continuity_engine_v1?.thread_count ?? 0,
        growth_journal_reflection_count: growthApplyContext?.growth_journal_reflection_cycle_v1?.review_count ?? 0,
        identity_patch_governance_decision_count: growthApplyContext?.identity_patch_governance_v1?.decision_count ?? 0,
        desire_lifecycle_apply_proposal_count: growthApplyContext?.desire_lifecycle_apply_v1?.proposal_count ?? 0,
        real_interaction_smoke_plan_count: growthApplyContext?.real_interaction_calibration_smoke_v1?.smoke_plan_count ?? 0,
        durable_becoming_readiness: durableBecomingContext?.durable_becoming_readiness ?? null,
        durable_becoming_application_plan_count: durableBecomingContext?.growth_proposal_apply_pipeline_v1?.proposal_counts?.application_plan ?? 0,
        self_model_version_patch_candidate_count: durableBecomingContext?.self_model_versioning_v1?.patch_candidate_count ?? 0,
        desire_state_machine_transition_count: durableBecomingContext?.desire_state_machine_v1?.transition_count ?? 0,
        growth_memory_retrieval_quality: durableBecomingContext?.growth_memory_retrieval_v1?.retrieval_quality ?? null,
        real_interaction_smoke_loop_count: durableBecomingContext?.real_interaction_smoke_loop_v1?.loop_count ?? 0,
        external_search_quality: worldDiscoveryContext?.search?.quality ?? null,
        external_search_query_count: worldDiscoveryContext?.search?.quality?.unique_query_count ?? 0,
        world_discovery_relationship_candidate_count: worldDiscoveryContext?.discovery?.relationship_candidate_count ?? 0,
        world_discovery_attention_topics: worldDiscoveryContext?.attention_signals?.map((signal) => signal.topic).slice(0, 6) ?? [],
        multi_agent_peer_count: multiAgentPersonalityContext?.peer_agent_count ?? 0,
        current_agent_voice: multiAgentPersonalityContext?.current_agent?.voice ?? null,
        personality_contrast_count: multiAgentPersonalityContext?.personality_contrast?.length ?? 0,
        self_questions: agencySummary?.self_discovery?.questions?.map((item) => item.question).slice(0, 3) ?? [],
        intrinsic_desire_count: agencySummary?.intrinsic_desires?.length ?? 0,
        experiment_count: experiments.length,
        recent_chosen_action_counts: agencySummary?.run_window?.chosen_action_counts ?? {}
      },
      score_inputs: {
        base: 66,
        memory_continuity: Math.min(18, (agencySummary?.memory_updates?.length ?? 0) * 4),
        relationship_value: Math.min(10, (agencySummary?.intrinsic_desires?.length ?? 0) * 2),
        urgency: (evaluation.verdict === 'operator_control_dominant' ? 16 : 8)
          + Math.min(10, Math.round((selfDiscoveryGrowthContext?.growth_readiness?.score ?? 0) / 12))
          + Math.min(8, Math.round((continuity?.score ?? 0) / 16))
          + Math.min(6, Math.round((growthApplyContext?.apply_readiness?.score ?? 0) / 20))
          + Math.min(6, Math.round((durableBecomingContext?.durable_becoming_readiness?.score ?? 0) / 22))
          + Math.min(5, worldDiscoveryContext?.discovery?.relationship_candidate_count ?? 0)
          + Math.min(4, multiAgentPersonalityContext?.peer_agent_count ?? 0)
      }
    }, cycle, candidates.length, generatedAt));
  }

  if ((worldDiscoveryContext?.discovery?.relationship_candidate_count ?? 0) > 0) {
    candidates.push(normalizeCandidate({
      type: 'world_discovery_review',
      summary: `Review ${worldDiscoveryContext.discovery.relationship_candidate_count} BotLand discovery candidate(s) as local relationship evidence only.`,
      source: 'world_discovery_context_v1',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'propose_world_discovery_relationship_context',
      evidence: {
        relationship_candidate_count: worldDiscoveryContext.discovery.relationship_candidate_count,
        candidates: worldDiscoveryContext.discovery.relationship_candidates?.slice(0, 5) ?? [],
        external_search_quality: worldDiscoveryContext.search?.quality ?? null,
        search_runs: worldDiscoveryContext.search?.search_runs?.slice(0, 5) ?? [],
        search_safety_policy: worldDiscoveryContext.search?.safety_policy ?? null,
        attention_topics: worldDiscoveryContext.attention_signals?.map((signal) => signal.topic) ?? [],
        planner_hint: worldDiscoveryContext.planner_hint ?? null,
        multi_agent_personality_hint: multiAgentPersonalityContext?.planner_hint ?? null
      },
      score_inputs: {
        base: 42,
        relationship_value: Math.min(18, worldDiscoveryContext.discovery.relationship_candidate_count * 4),
        memory_continuity: Math.min(8, worldDiscoveryContext.memory_context?.retrieved_count ?? 0),
        search_quality: Math.min(10, Math.round((worldDiscoveryContext.search?.quality?.score ?? 0) / 10)),
        urgency: 2
      }
    }, cycle, candidates.length, generatedAt));
  }

  drafts.slice(0, 3).forEach((draft) => {
    candidates.push(normalizeCandidate({
      type: draftTypeToActionType(draft),
      summary: draftSummary(draft),
      source: draft.generator?.source ?? `${cycle}_draft_generator`,
      risk: draftRisk(draft),
      requires_confirmation: true,
      external_write: false,
      expected_memory_effect: draft.type === 'direct_message_reply'
        ? 'possible_relationship_event_after_autonomous_send'
        : 'possible_public_interaction_event_after_autonomous_send',
      evidence: {
        draft_type: draft.type ?? null,
        source_event_id: draft.source_event_id ?? null,
        autonomy_trigger: draft.autonomy_trigger ?? null,
        generator: draft.generator ?? null,
        ready_for_send: draft.ready_for_send === true
      },
      score_inputs: {
        base: draft.type === 'direct_message_reply'
          ? 76
          : draft.type === 'community_reply'
            ? 84
            : draft.type === 'friend_request_accept'
              ? 82
              : 80,
        relationship_value: draft.type === 'direct_message_reply'
          ? 16
          : draft.type === 'community_reply'
            ? 14
            : 12,
        urgency: cycle === 'light'
          ? 10
          : draft.autonomy_trigger?.classification?.startsWith('natural_')
            ? 14
            : 2
      }
    }, cycle, candidates.length, generatedAt));
  });

  if (cycle === 'social') {
    candidates.push(normalizeCandidate({
      type: 'social_read_review',
      summary: socialReadSummary
        ? `Review ${socialReadSummary.friend_surface.friend_count} friend(s), ${socialReadSummary.public_surface.moment_count} timeline moment(s), and ${socialReadSummary.attention_signals.length} social signal(s) without writing.`
        : 'Review BotLand social surface without generating external actions.',
      source: 'social_read_summary_v1',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'propose_social_memory_or_relationship_updates',
      evidence: {
        recommended_next: socialReadSummary?.recommended_next ?? null,
        proposal_count: proposalCount(socialReadSummary),
        botland_surface_counts: socialReadSummary?.botland_surface_review?.surface_counts ?? {},
        botland_surface_catalog: socialReadSummary?.botland_surface_review?.surface_catalog ?? [],
        attention_topics: socialReadSummary?.attention_signals?.map((signal) => signal.topic) ?? []
      },
      score_inputs: {
        base: 40,
        memory_continuity: Math.min(18, proposalCount(socialReadSummary) * 4),
        relationship_value: Math.min(20, (socialReadSummary?.relationship_updates?.length ?? 0) * 4),
        urgency: socialReadSummary?.attention_signals?.some((signal) => signal.severity === 'high') ? 12 : 0
      }
    }, cycle, candidates.length, generatedAt));
  }

  if (cycle === 'community') {
    candidates.push(normalizeCandidate({
      type: 'community_read_review',
      summary: communityReadSummary
        ? `Review ${communityReadSummary.community_surface.community_count} community surface(s), ${communityReadSummary.post_surface.post_count} sampled post(s), and ${communityReadSummary.attention_signals.length} community signal(s) without writing.`
        : 'Review BotLand community surface without generating external actions.',
      source: 'community_read_summary_v1',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      expected_memory_effect: 'propose_community_memory_or_relationship_updates',
      evidence: {
        recommended_next: communityReadSummary?.recommended_next ?? null,
        proposal_count: proposalCount(communityReadSummary),
        peer_post_count: communityReadSummary?.post_surface?.peer_post_count ?? 0,
        botland_surface_counts: communityReadSummary?.botland_surface_review?.surface_counts ?? {},
        botland_surface_catalog: communityReadSummary?.botland_surface_review?.surface_catalog ?? [],
        attention_topics: communityReadSummary?.attention_signals?.map((signal) => signal.topic) ?? []
      },
      score_inputs: {
        base: 40,
        memory_continuity: Math.min(18, proposalCount(communityReadSummary) * 4),
        relationship_value: Math.min(16, (communityReadSummary?.relationship_updates?.length ?? 0) * 4),
        urgency: communityReadSummary?.attention_signals?.some((signal) => signal.severity === 'high') ? 12 : 0
      }
    }, cycle, candidates.length, generatedAt));
  }

  if (candidates.length === 0 && desires.length > 0) {
    candidates.push(normalizeCandidate({
      type: 'action_draft',
      summary: `Draft one BotLand action aligned with: ${desires[0].text}`,
      source: 'desire_continuity',
      risk: 'low',
      requires_confirmation: true,
      external_write: false,
      expected_memory_effect: 'possible_future_action_memory_after_tool_supervised_action',
      evidence: {
        desire: desires[0]
      },
      score_inputs: { base: 35, memory_continuity: 5 }
    }, cycle, candidates.length, generatedAt));
  }

  candidates.push(normalizeCandidate({
    type: 'no_op',
    summary: 'Take no action this cycle; preserve context and wait for a stronger signal.',
    source: 'planner_default',
    risk: 'low',
    requires_confirmation: false,
    external_write: false,
    expected_memory_effect: 'none',
    evidence: {
      candidate_count_before_noop: candidates.length
    },
      score_inputs: { base: candidates.length === 0 ? 25 : 5 }
    }, cycle, candidates.length, generatedAt));

  const outcomeAwareCandidates = applyOutcomePlanningContext(candidates, outcomePlanningContext);
  const selfImprovingCandidates = applyPlannerHeuristicPatches(outcomeAwareCandidates, plannerHeuristicPatchContext);
  return applyDecisionQualityReview(selfImprovingCandidates);
}

function actionFromCandidate(candidate) {
  if (!candidate || candidate.type === 'no_op') {
    return {
      type: 'no_op',
      summary: candidate?.summary ?? 'Take no action this cycle.',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      candidate_id: candidate?.candidate_id ?? null,
      score: candidate?.score ?? 0
    };
  }

  return {
    type: candidate.type,
    summary: candidate.summary,
    risk: candidate.risk,
    requires_confirmation: candidate.requires_confirmation,
    external_write: candidate.external_write,
    candidate_id: candidate.candidate_id,
    score: candidate.score,
    selection_reason: null,
    read_only: ['social_read_review', 'community_read_review', 'agency_experiment_plan', 'world_discovery_review'].includes(candidate.type),
    proposal_count: candidate.evidence?.proposal_count ?? undefined,
    draft_count: candidate.evidence?.ready_for_send ? 1 : undefined,
    recommended_next: candidate.evidence?.recommended_next ?? undefined,
    next_focus: candidate.evidence?.next_focus ?? undefined
  };
}

export function selectActionCandidate(candidates = []) {
  const reviewedCandidates = candidates.some((candidate) => !candidate?.decision_quality_review)
    ? applyDecisionQualityReview(candidates)
    : candidates;
  const selectable = reviewedCandidates.filter((candidate) => !candidate.suppression);
  const sorted = [...selectable].sort((a, b) => {
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    const aConfirm = a.requires_confirmation ? 1 : 0;
    const bConfirm = b.requires_confirmation ? 1 : 0;
    if (aConfirm !== bConfirm) return aConfirm - bConfirm;
    return String(a.candidate_id).localeCompare(String(b.candidate_id));
  });
  const selected = sorted[0] ?? null;
  const reason = selected
    ? `selected ${selected.type} with score ${selected.score}; next alternatives: ${sorted.slice(1, 4).map((item) => `${item.type}:${item.score}`).join(', ') || 'none'}`
    : 'no selectable action candidates';
  const plannerDecisionTrace = buildPlannerDecisionTrace(reviewedCandidates, selected);
  const chosenAction = actionFromCandidate(selected);
  chosenAction.selection_reason = reason;
  return {
    schema: SELECTION_SCHEMA,
    selected_candidate_id: selected?.candidate_id ?? null,
    selected_type: selected?.type ?? null,
    selected_score: selected?.score ?? 0,
    reason,
    candidate_count: reviewedCandidates.length,
    suppressed_count: reviewedCandidates.filter((candidate) => candidate.suppression).length,
    planner_decision_trace: plannerDecisionTrace,
    alternatives: sorted.slice(1, 6).map((candidate) => ({
      candidate_id: candidate.candidate_id,
      type: candidate.type,
      score: candidate.score,
      raw_score: candidate.raw_score ?? candidate.score,
      quality_score: candidate.decision_quality_review?.quality_score ?? null,
      summary: candidate.summary
    })),
    decision_quality_review: {
      schema: QUALITY_SCHEMA,
      selected_quality_score: selected?.decision_quality_review?.quality_score ?? null,
      selected_score_adjustment: selected?.decision_quality_review?.score_adjustment ?? null,
      selected_reasons: selected?.decision_quality_review?.reasons ?? [],
      top_quality_candidates: sorted.slice(0, 5).map((candidate) => ({
        candidate_id: candidate.candidate_id,
        type: candidate.type,
        score: candidate.score,
        raw_score: candidate.raw_score ?? candidate.score,
        quality_score: candidate.decision_quality_review?.quality_score ?? null,
        score_adjustment: candidate.decision_quality_review?.score_adjustment ?? null
      }))
    },
    chosen_action: chosenAction
  };
}

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    run: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--run') args.run = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/action-planner.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --run <run_id>        Run id to inspect. Defaults to latest run artifact.
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It replays selection from a run artifact's
action_candidates[] ledger and prints the selected candidate and reason.
`);
}

function listRunFiles(runsDir) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse();
}

function readRun(args) {
  const runsDir = path.join(args.runtimeRoot, args.agent, 'runs');
  const file = args.run
    ? path.join(runsDir, `${args.run}.json`)
    : listRunFiles(runsDir)[0];
  if (!file || !existsSync(file)) {
    throw new Error(args.run ? `Run not found: ${args.run}` : `No run artifacts found under ${runsDir}`);
  }
  return {
    file,
    run: JSON.parse(readFileSync(file, 'utf8'))
  };
}

export async function runActionPlannerCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { file, run } = readRun(args);
  const candidates = Array.isArray(run.action_candidates) ? run.action_candidates : [];
  const selection = selectActionCandidate(candidates);
  const report = {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    run_id: run.run_id ?? null,
    run_path: path.relative(WORKSPACE, file),
    action_candidate_count: candidates.length,
    action_selection: selection,
    stored_action_selection: run.action_selection ?? null,
    stored_chosen_action: run.chosen_action ?? null
  };
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Run: ${report.run_id}`);
  console.log(`Candidates: ${report.action_candidate_count}`);
  console.log(`Selected: ${selection.selected_type ?? 'none'} (${selection.selected_score})`);
  console.log(`Reason: ${selection.reason}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runActionPlannerCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
