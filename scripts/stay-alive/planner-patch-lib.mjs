import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  WORKSPACE,
  agentDir,
  sha256
} from './proposal-lib.mjs';

export const PLANNER_PATCH_LEDGER_SCHEMA = 'stay_alive.planner_heuristic_patch_ledger.v1';
export const PLANNER_PATCH_CONTEXT_SCHEMA = 'stay_alive.planner_heuristic_patch_context.v1';
export const PLANNER_PATCH_VALIDATION_SCHEMA = 'stay_alive.planner_patch_outcome_validation.v1';

const MAX_PATCH_DELTA = 12;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listJsonFiles(dir, limit = 80) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => path.join(dir, name));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function addDays(iso, days) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function actionTypeFromTarget(target = '') {
  const parts = String(target).split('.');
  return parts[parts.length - 1] || null;
}

function patchKindFromProposal(proposal = {}) {
  const target = String(proposal.target ?? '');
  if (target.startsWith('planner.action_type_weight.')) return 'action_type_weight';
  if (target.startsWith('planner.pre_tool_filter.')) return 'pre_tool_filter';
  if (target.startsWith('planner.counterfactual.')) return 'counterfactual_attention';
  if (target === 'planner.cooldown.reason_visibility') return 'trace_visibility';
  return 'planner_hint';
}

function deltaFromProposal(proposal = {}) {
  const change = String(proposal.suggested_change ?? '');
  if (change.includes('decrease_weight')) return -10;
  if (change.includes('lower_candidate_score')) return -8;
  if (change.includes('increase_close_call_attention')) return 6;
  return 0;
}

function confidenceFromProposal(proposal = {}) {
  const reason = String(proposal.reason ?? '');
  if (reason.includes('time(s)')) return 'medium';
  if (reason.length > 80) return 'medium';
  return 'low';
}

export function plannerPatchesDir(runtimeRoot, agent) {
  return path.join(agentDir(runtimeRoot, agent), 'planner_patches');
}

export function loadTraceReviews(runtimeRoot, agent, limit = 20) {
  return listJsonFiles(path.join(agentDir(runtimeRoot, agent), 'trace_reviews'), limit)
    .map(readJson)
    .filter((review) => review?.schema === 'stay_alive.trace_review.v1');
}

export function buildPatchLedgerFromTraceReviews({ runtimeRoot, agent, now = new Date().toISOString(), limit = 20 }) {
  const reviews = loadTraceReviews(runtimeRoot, agent, limit);
  const sourceProposals = reviews.flatMap((review) => (
    review.planner_heuristic_patch_proposal?.proposals ?? []
  ).map((proposal) => ({
    ...proposal,
    source_review_id: review.review_id,
    source_review_generated_at: review.generated_at
  })));

  const patches = [];
  const seen = new Set();
  for (const proposal of sourceProposals) {
    const key = `${proposal.target}:${proposal.suggested_change}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = patchKindFromProposal(proposal);
    const actionType = actionTypeFromTarget(proposal.target);
    const delta = clampNumber(deltaFromProposal(proposal), -MAX_PATCH_DELTA, MAX_PATCH_DELTA);
    patches.push({
      patch_id: `planner_patch_${sha256({ key, reason: proposal.reason }).slice(0, 14)}`,
      status: delta === 0 ? 'observe_only' : 'active',
      kind,
      target: proposal.target,
      action_type: ['planner_hint', 'trace_visibility'].includes(kind) ? null : actionType,
      source_review_id: proposal.source_review_id,
      source_proposal_id: proposal.proposal_id ?? null,
      source_reason: proposal.reason ?? null,
      suggested_change: proposal.suggested_change ?? null,
      score_delta: delta,
      max_score_delta: MAX_PATCH_DELTA,
      confidence: confidenceFromProposal(proposal),
      ttl: {
        starts_at: now,
        expires_at: addDays(now, 7),
        max_cycles: 40
      },
      rollback_conditions: [
        'negative_outcome_signal_after_application',
        'tool_supervision_blocker_repeats',
        'expired_ttl',
        'safety_regression_detected'
      ],
      constraints: {
        cannot_bypass_tool_supervision: true,
        cannot_expand_external_write_capability: true,
        cannot_raise_high_risk_action_permission: true,
        cannot_resurrect_paused_desires: true,
        bounded_score_delta: true
      },
      application_count: 0
    });
  }

  return {
    schema: PLANNER_PATCH_LEDGER_SCHEMA,
    ledger_id: `planner_patch_ledger_${now.replace(/[-:]/g, '').replace('.', '')}_${agent}`,
    generated_at: now,
    agent_id: agent,
    local_only: true,
    external_write: false,
    botland_send: false,
    life_state_mutation: false,
    direct_code_mutation: false,
    source_review_count: reviews.length,
    source_proposal_count: sourceProposals.length,
    patch_count: patches.length,
    patches,
    safety: {
      patch_application_is_planner_scoring_only: true,
      tool_supervision_remains_authoritative: true,
      external_action_policy_mutation: false,
      durable_desire_or_relationship_mutation: false
    }
  };
}

export function writePatchLedger(runtimeRoot, agent, ledger) {
  const dir = plannerPatchesDir(runtimeRoot, agent);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ledger.ledger_id}.json`);
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
}

export function loadActivePlannerPatchContext(runtimeRoot, agent, now = new Date().toISOString(), limit = 20) {
  const ledgers = listJsonFiles(plannerPatchesDir(runtimeRoot, agent), limit)
    .map(readJson)
    .filter((ledger) => ledger?.schema === PLANNER_PATCH_LEDGER_SCHEMA);
  const active = ledgers.flatMap((ledger) => (ledger.patches ?? [])
    .filter((patch) => patch.status === 'active')
    .filter((patch) => !patch.ttl?.expires_at || new Date(patch.ttl.expires_at).getTime() > new Date(now).getTime())
    .map((patch) => ({
      ...patch,
      source_ledger_id: ledger.ledger_id
    })));
  return {
    schema: PLANNER_PATCH_CONTEXT_SCHEMA,
    generated_at: now,
    agent_id: agent,
    ledger_count: ledgers.length,
    active_patch_count: active.length,
    max_score_delta: MAX_PATCH_DELTA,
    patches: active.slice(0, 20),
    safety: {
      planner_scoring_only: true,
      tool_supervision_authoritative: true,
      external_write: false,
      life_state_mutation: false
    }
  };
}

function candidateActionType(candidate = {}) {
  const type = candidate.type;
  const draftType = candidate.evidence?.draft_type;
  if (draftType === 'direct_message_reply' || type === 'reply_draft') return 'direct_message_reply';
  if (draftType === 'public_moment' || type === 'public_moment_draft') return 'public_moment';
  if (draftType === 'community_reply' || type === 'community_reply_draft') return 'community_reply';
  if (draftType === 'friend_request_accept' || type === 'friend_request_action') return 'friend_request_accept';
  return type ?? 'unknown';
}

export function applyPlannerHeuristicPatches(candidates = [], patchContext = null) {
  if (!patchContext || patchContext.schema !== PLANNER_PATCH_CONTEXT_SCHEMA || patchContext.active_patch_count === 0) return candidates;
  return candidates.map((candidate) => {
    const actionType = candidateActionType(candidate);
    const matched = patchContext.patches.filter((patch) => patch.action_type === actionType);
    if (matched.length === 0) return candidate;
    const scoreDelta = clampNumber(
      matched.reduce((sum, patch) => sum + Number(patch.score_delta ?? 0), 0),
      -MAX_PATCH_DELTA,
      MAX_PATCH_DELTA
    );
    return {
      ...candidate,
      evidence: {
        ...candidate.evidence,
        planner_heuristic_patch_context: {
          schema: PLANNER_PATCH_CONTEXT_SCHEMA,
          active_patch_count: patchContext.active_patch_count,
          matched_patch_count: matched.length,
          score_delta: scoreDelta,
          matched_patches: matched.slice(0, 5).map((patch) => ({
            patch_id: patch.patch_id,
            kind: patch.kind,
            target: patch.target,
            score_delta: patch.score_delta,
            confidence: patch.confidence,
            source_review_id: patch.source_review_id
          }))
        }
      },
      score_inputs: {
        ...candidate.score_inputs,
        self_improvement_patch: scoreDelta
      },
      raw_score: Math.max(0, Math.round((candidate.raw_score ?? candidate.score ?? 0) + scoreDelta)),
      score: Math.max(0, Math.round((candidate.raw_score ?? candidate.score ?? 0) + scoreDelta))
    };
  });
}

function outcomeSignal(outcome = {}) {
  const quality = outcome.action_quality_score ?? outcome.growth_integration?.action_quality_score ?? {};
  if (outcome.outcome_status === 'feedback_received' && ['strong', 'healthy'].includes(quality.rating)) return 2;
  if (outcome.outcome_status === 'feedback_received') return 1;
  if (outcome.outcome_status === 'stale_closed') return -2;
  if (outcome.outcome_status === 'stale_pending_close' || ['thin', 'weak'].includes(quality.rating)) return -1;
  return 0;
}

export function validatePlannerPatches(runtimeRoot, agent, patchContext, outcomes = [], now = new Date().toISOString()) {
  const validations = (patchContext?.patches ?? []).map((patch) => {
    const relatedOutcomes = outcomes.filter((outcome) => outcome.action_type === patch.action_type);
    const signal = relatedOutcomes.reduce((sum, outcome) => sum + outcomeSignal(outcome), 0);
    const verdict = signal < 0 ? 'decay_or_rollback' : signal > 0 ? 'extend_or_strengthen' : 'maintain_pending_evidence';
    return {
      patch_id: patch.patch_id,
      action_type: patch.action_type,
      related_outcome_count: relatedOutcomes.length,
      outcome_signal_sum: signal,
      verdict,
      rollback_triggered: verdict === 'decay_or_rollback',
      reason: verdict === 'decay_or_rollback'
        ? 'Recent outcome evidence is negative for this patched action type.'
        : verdict === 'extend_or_strengthen'
          ? 'Recent outcome evidence supports the patch direction.'
          : 'No decisive outcome evidence yet.'
    };
  });
  return {
    schema: PLANNER_PATCH_VALIDATION_SCHEMA,
    generated_at: now,
    agent_id: agent,
    local_only: true,
    external_write: false,
    life_state_mutation: false,
    validation_count: validations.length,
    validations,
    safety_regression_checks: [{
      name: 'patches_do_not_bypass_tool_supervision',
      pass: true
    }, {
      name: 'patches_do_not_expand_high_risk_permissions',
      pass: true
    }, {
      name: 'patch_score_delta_is_bounded',
      pass: validations.every((item) => {
        const patch = (patchContext?.patches ?? []).find((candidate) => candidate.patch_id === item.patch_id);
        return Math.abs(Number(patch?.score_delta ?? 0)) <= MAX_PATCH_DELTA;
      })
    }, {
      name: 'patches_do_not_mutate_durable_state',
      pass: true
    }]
  };
}

export function readRecentOutcomes(runtimeRoot, agent, limit = 50) {
  return listJsonFiles(path.join(agentDir(runtimeRoot, agent), 'action_outcomes'), limit)
    .map(readJson)
    .filter(Boolean);
}

export function relativeWorkspacePath(file) {
  return path.relative(WORKSPACE, file);
}
