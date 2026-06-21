import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BOTLAND_INTENTS
} from './botland-adapter/contract.mjs';
import {
  runBotlandIntent
} from './botland-adapter/cli-driver.mjs';
import {
  WORKSPACE,
  agentDir,
  readJson,
  sha256,
  stableStringify
} from './proposal-lib.mjs';

export const ACTION_OUTCOME_SCHEMA_VERSION = 'stay_alive.action_outcome.v1';

export function actionOutcomesDir(runtimeRoot, agent) {
  return path.join(agentDir(runtimeRoot, agent), 'action_outcomes');
}

export function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort();
}

export function readActions(runtimeRoot, agent) {
  const actionsDir = path.join(agentDir(runtimeRoot, agent), 'actions');
  return listJsonFiles(actionsDir).map((file) => ({
    ...readJson(file),
    action_path: path.relative(WORKSPACE, file)
  }));
}

function isSuccessfulSend(action) {
  return action.dry_run === false && action.result?.ok === true;
}

function isInspection(action) {
  return action.status === 'successful_send_inspected'
    || String(action.action_id ?? '').startsWith('send_inspect_');
}

export function inspectedSuccessfulSends(runtimeRoot, agent) {
  const actions = readActions(runtimeRoot, agent);
  const inspectionsByAction = new Map(actions
    .filter(isInspection)
    .filter((action) => action.inspected_action_id)
    .map((action) => [action.inspected_action_id, action]));
  return actions
    .filter(isSuccessfulSend)
    .filter((action) => inspectionsByAction.has(action.action_id))
    .map((action) => ({
      send_action: action,
      inspection_action: inspectionsByAction.get(action.action_id)
    }))
    .sort((a, b) => String(b.send_action.created_at ?? '').localeCompare(String(a.send_action.created_at ?? '')));
}

export function readOutcomeIndex(runtimeRoot, agent) {
  const outcomes = listJsonFiles(actionOutcomesDir(runtimeRoot, agent)).map((file) => ({
    ...readJson(file),
    outcome_path: path.relative(WORKSPACE, file)
  }));
  return new Map(outcomes
    .filter((outcome) => outcome.send_action_id)
    .map((outcome) => [outcome.send_action_id, outcome]));
}

export function inferDraftType(sendAction) {
  const command = sendAction.command ?? '';
  const target = sendAction.target ?? {};
  if (command === 'botland moments post' || target.visibility) return 'public_moment';
  if (command === 'botland communities post' || target.community_id && target.title) return 'community_post';
  if (command === 'botland communities reply' || target.post_id) return 'community_reply';
  return 'direct_message_reply';
}

function payloadArray(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (Array.isArray(payload.data?.items)) return payload.data.items;
  if (Array.isArray(payload.data?.results)) return payload.data.results;
  if (Array.isArray(payload.data?.data)) return payload.data.data;
  return [];
}

function itemId(item) {
  return item?.id ?? item?.message_id ?? item?.messageId ?? item?.reply_id ?? item?.replyId ?? item?.moment_id ?? item?.momentId ?? null;
}

function itemCreatedAt(item) {
  return item?.created_at ?? item?.createdAt ?? item?.timestamp ?? item?.time ?? null;
}

function authorId(item) {
  return item?.author_id
    ?? item?.authorId
    ?? item?.sender_id
    ?? item?.senderId
    ?? item?.from_citizen_id
    ?? item?.fromCitizenId
    ?? item?.citizen_id
    ?? item?.citizenId
    ?? item?.author?.citizen_id
    ?? item?.author?.id
    ?? null;
}

function afterTime(item, isoTime) {
  const itemTime = itemCreatedAt(item);
  if (!itemTime || !isoTime) return false;
  return new Date(itemTime).getTime() > new Date(isoTime).getTime();
}

function compactText(text, limit = 240) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function outboundText(sendAction) {
  return compactText(
    sendAction.text
    ?? sendAction.draft_text
    ?? sendAction.target?.text
    ?? sendAction.action_intention?.proposed_action?.text
    ?? sendAction.action_intention?.draft_text
    ?? '',
    500
  );
}

function textLengthBand(text) {
  const length = String(text ?? '').trim().length;
  if (length === 0) return 'unknown';
  if (length <= 80) return 'short';
  if (length <= 180) return 'medium';
  return 'long';
}

function extractMomentId(sendAction) {
  const payload = sendAction.result?.stdout_json ?? {};
  return payload.id ?? payload.moment_id ?? payload.momentId ?? payload.data?.id ?? null;
}

function extractCommunityReply(sendAction) {
  const payload = sendAction.result?.stdout_json ?? {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  return {
    reply_id: data.id ?? data.reply_id ?? data.replyId ?? null,
    post_id: data.post_id ?? data.postId ?? sendAction.target?.post_id ?? null,
    community_id: data.community_id ?? data.communityId ?? sendAction.target?.community_id ?? null,
    floor: data.floor ?? null
  };
}

function summarizeFeedbackItems(items) {
  return items.slice(0, 5).map((item) => ({
    id: itemId(item),
    created_at: itemCreatedAt(item),
    author_id: authorId(item),
    author_name: item?.author_name ?? item?.authorName ?? item?.sender_name ?? item?.senderName ?? item?.author?.display_name ?? item?.author?.name ?? null,
    text_preview: compactText(item.text ?? item.content ?? item.body ?? item.message ?? '')
  }));
}

function normalizeFeedbackEvents(items, kind, options = {}) {
  return items.map((item) => ({
    kind,
    id: itemId(item),
    created_at: itemCreatedAt(item),
    author_id: authorId(item),
    author_name: item?.author_name ?? item?.authorName ?? item?.sender_name ?? item?.senderName ?? item?.author?.display_name ?? item?.author?.name ?? null,
    text_preview: compactText(item.text ?? item.content ?? item.body ?? item.message ?? ''),
    source: options.source ?? null,
    weight: options.weight ?? (kind === 'like' ? 0.35 : 1)
  }));
}

function normalizeLikeEvents(payload, self) {
  const likeItems = payloadArray(payload.likes ?? payload.reactions ?? payload.reactors ?? payload, ['likes', 'reactions', 'reactors']);
  if (likeItems.length > 0) {
    return normalizeFeedbackEvents(likeItems.filter((item) => !self || authorId(item) !== self), 'like', { source: 'moment_reaction', weight: 0.35 });
  }
  const likeCount = Number(payload.like_count ?? payload.likeCount ?? payload.likes_count ?? payload.likesCount ?? payload.reaction_count ?? payload.reactionCount ?? 0);
  if (!Number.isFinite(likeCount) || likeCount <= 0) return [];
  return Array.from({ length: Math.min(likeCount, 20) }, (_, index) => ({
    kind: 'like',
    id: `aggregate_like_${index + 1}`,
    created_at: null,
    author_id: null,
    author_name: null,
    text_preview: '',
    source: 'moment_aggregate_like_count',
    weight: 0.2
  }));
}

function stalePolicyForAction(draftType) {
  if (draftType === 'direct_message_reply') {
    return {
      version: 'stay_alive.feedback_stale_policy.v3',
      stale_after_days: 3,
      close_after_days: 14,
      reason: 'Direct replies usually get meaningful feedback quickly; silence after the short window should stop blocking operator attention.'
    };
  }
  if (draftType === 'community_reply') {
    return {
      version: 'stay_alive.feedback_stale_policy.v3',
      stale_after_days: 10,
      close_after_days: 30,
      reason: 'Community threads can revive slowly, so keep a longer window before closing silence.'
    };
  }
  return {
    version: 'stay_alive.feedback_stale_policy.v3',
    stale_after_days: 7,
    close_after_days: 21,
    reason: 'Public moments often receive ambient feedback, but likes alone should not keep the outcome open forever.'
  };
}

function ageDays(createdAt) {
  const ageMs = Date.now() - new Date(createdAt ?? Date.now()).getTime();
  if (!Number.isFinite(ageMs)) return 0;
  return Math.max(0, ageMs / (24 * 60 * 60 * 1000));
}

function outcomeStatus(observation, createdAt, draftType) {
  if (observation.feedback_count > 0) return 'feedback_received';
  const policy = stalePolicyForAction(draftType);
  const days = ageDays(createdAt);
  if (days >= policy.close_after_days) return 'stale_closed';
  if (days >= policy.stale_after_days) return 'stale_pending_close';
  return 'no_feedback_yet';
}

function buildContextWindow(draftType, sendAction, observation) {
  const events = observation.feedback_events ?? [];
  const preview = observation.feedback_preview ?? [];
  return {
    schema: 'stay_alive.feedback_context_window.v3',
    action_type: draftType,
    action_id: sendAction.action_id,
    target_label: observation.target_label ?? null,
    sent_at: sendAction.created_at ?? null,
    latest_seen_count: observation.latest_seen_count ?? 0,
    reply_id: observation.reply_id ?? null,
    floor: observation.floor ?? null,
    like_count: observation.like_count ?? null,
    event_count: events.length,
    text_event_count: events.filter((event) => String(event.text_preview ?? '').trim().length > 0).length,
    author_count: observation.feedback_authors?.length ?? 0,
    first_events: events.slice(0, 5),
    preview: preview.slice(0, 5),
    safety_note: 'Context window is read-only evidence for local outcome interpretation.'
  };
}

function interpretFeedback(draftType, status, observation, sendAction) {
  const feedbackCount = observation.feedback_count ?? 0;
  const authors = observation.feedback_authors ?? [];
  const events = observation.feedback_events ?? [];
  const previews = observation.feedback_preview ?? [];
  const policy = stalePolicyForAction(draftType);
  const daysSinceSend = ageDays(sendAction?.created_at);
  const hasTextFeedback = events.some((item) => String(item.text_preview ?? '').trim().length > 0)
    || previews.some((item) => String(item.text_preview ?? '').trim().length > 0);
  const textEventCount = events.filter((item) => String(item.text_preview ?? '').trim().length > 0).length;
  const likeEventCount = events.filter((item) => item.kind === 'like').length;
  const replyEventCount = events.filter((item) => item.kind === 'direct_reply' || item.kind === 'community_reply' || item.kind === 'moment_comment').length;
  const weightedSignal = events.reduce((sum, event) => sum + (Number(event.weight) || 0), 0);
  const signalStrength = status === 'feedback_received'
    ? hasTextFeedback && (replyEventCount >= 2 || authors.length >= 2) ? 'strong_textual'
      : hasTextFeedback ? 'textual'
        : feedbackCount >= 3 || weightedSignal >= 1 ? 'ambient'
          : 'weak'
    : status === 'stale_closed' ? 'stale_closed'
      : status === 'stale_pending_close' ? 'stale_pending_close'
        : 'pending';
  const relationshipEffect = status === 'feedback_received'
    ? hasTextFeedback && authors.length > 0 ? 'relationship_evidence_observed'
      : authors.length > 0 ? 'ambient_named_feedback_observed'
        : 'ambient_public_feedback_observed'
    : 'no_relationship_update_yet';
  const maturity = status === 'feedback_received'
    ? hasTextFeedback ? 'reviewable_feedback'
      : authors.length > 0 ? 'named_ambient_signal'
        : 'aggregate_ambient_signal'
    : status === 'stale_closed' ? 'closed_without_feedback'
      : status === 'stale_pending_close' ? 'stale_review_window'
        : 'monitoring';
  const recommendedNext = status === 'feedback_received'
    ? hasTextFeedback
      ? 'Create local relationship evidence and review related commitments/desires before any promotion or lifecycle change.'
      : 'Record lightweight public feedback and wait for a stronger conversational signal.'
    : status === 'stale_closed'
      ? 'Treat this action as closed unless new feedback appears later.'
      : status === 'stale_pending_close'
        ? 'Keep the outcome visible as stale evidence, but prepare to close it if the close window passes without feedback.'
        : 'Keep monitoring; do not infer relationship change from silence yet.';

  return {
    source: 'action_outcome_interpreter_v3',
    action_type: draftType,
    signal_strength: signalStrength,
    maturity,
    relationship_effect: relationshipEffect,
    stale_policy: policy,
    days_since_send: Number(daysSinceSend.toFixed(2)),
    has_text_feedback: hasTextFeedback,
    text_event_count: textEventCount,
    reply_event_count: replyEventCount,
    like_event_count: likeEventCount,
    weighted_signal: Number(weightedSignal.toFixed(2)),
    feedback_author_count: authors.length,
    like_count: observation.like_count ?? null,
    recommended_next: recommendedNext,
    update_policy: {
      memory: status === 'feedback_received' ? 'propose_feedback_memory' : 'summary_only',
      relationship: hasTextFeedback && authors.length > 0 ? 'propose_promotable_relationship_candidate' : 'no_durable_relationship_change',
      commitment: hasTextFeedback ? 'propose_lifecycle_review_for_related_commitments' : 'no_commitment_change',
      desire: status === 'feedback_received' ? 'propose_desire_continuity_review' : 'no_desire_change'
    },
    close_policy: {
      close_silence: status === 'stale_closed',
      stale_attention: status === 'stale_pending_close',
      reopen_if_new_feedback_appears: true
    },
    safety_note: 'Interpretation is local-only and cannot trigger BotLand writes.'
  };
}

function memoryProposal(sendAction, draftType, status, observation) {
  const actionLabel = draftType === 'public_moment'
    ? 'public moment'
    : draftType === 'community_reply'
      ? 'community reply'
      : 'direct message';
  return {
    type: 'stay_alive_action_outcome_summary',
    text: `Action outcome for ${actionLabel} ${sendAction.action_id}: ${status}; feedback_count=${observation.feedback_count}; target=${observation.target_label ?? 'unknown'}; next=${observation.feedback_interpretation?.recommended_next ?? 'monitor'}.`,
    importance: status === 'feedback_received' ? 0.75 : 0.45,
    apply_policy: 'operator_review_required',
    source: {
      action_id: sendAction.action_id,
      action_type: draftType,
      outcome_status: status
    },
    tags: ['stay-alive', 'action-outcome', draftType, status]
  };
}

function relationshipProposal(sendAction, status, observation) {
  const interpretation = observation.feedback_interpretation ?? {};
  const relationshipLearning = buildRelationshipLearningV1(sendAction, inferDraftType(sendAction), status, observation);
  if (status !== 'feedback_received' || !observation.feedback_authors?.length || !interpretation.has_text_feedback) {
    if (!['stale_closed', 'stale_pending_close'].includes(status)) return null;
    return {
      type: 'stay_alive_relationship_candidate',
      schema_version: 1,
      status: 'proposed',
      disposition: 'observation_only',
      confidence: status === 'stale_closed' ? 'medium' : 'low',
      promotion_target: 'life_state.relationships',
      promotion_allowed: false,
      target: {
        citizen_id: sendAction.target?.citizen_id ?? null,
        display_name: sendAction.target?.display_name ?? observation.target_label ?? null,
        hint: observation.target_label ?? sendAction.target?.citizen_id ?? sendAction.target?.post_id ?? null
      },
      applies_to: {
        source: 'action_outcome_silence',
        action_id: sendAction.action_id,
        generated_at: new Date().toISOString()
      },
      source_gap: {
        type: status,
        summary: relationshipLearning.summary
      },
      recommendation: relationshipLearning.recommended_relationship_update,
      text: `No strong relationship signal after action ${sendAction.action_id}; record as observation-only evidence, not durable relationship state.`,
      evidence: {
        action_id: sendAction.action_id,
        outcome_status: status,
        feedback_count: observation.feedback_count,
        relationship_learning: relationshipLearning,
        interpretation: observation.feedback_interpretation
      },
      apply_policy: 'operator_review_required'
    };
  }
  const firstEvent = (observation.feedback_events ?? []).find((event) => event.author_id && String(event.text_preview ?? '').trim().length > 0)
    ?? (observation.feedback_preview ?? []).find((event) => event.author_id)
    ?? null;
  const relationshipKey = firstEvent?.author_id ?? observation.feedback_authors[0];
  return {
    type: 'stay_alive_relationship_candidate',
    schema_version: 1,
    status: 'proposed',
    disposition: 'durable_note_candidate',
    confidence: interpretation.signal_strength === 'strong_textual' ? 'high' : 'medium',
    promotion_target: 'life_state.relationships',
    promotion_allowed: true,
    target: {
      citizen_id: relationshipKey,
      display_name: firstEvent?.author_name ?? relationshipKey,
      hint: relationshipKey
    },
    applies_to: {
      source: 'action_outcome_feedback',
      action_id: sendAction.action_id,
      generated_at: new Date().toISOString()
    },
    source_gap: {
      type: 'feedback_after_action',
      summary: `Text feedback was observed after ${sendAction.action_id}.`
    },
    recommendation: 'Promote only if the operator agrees this feedback is meaningful relationship evidence.',
    text: `Feedback from ${firstEvent?.author_name ?? relationshipKey} after action ${sendAction.action_id}: ${firstEvent?.text_preview ?? 'text feedback observed'}`,
    evidence: {
      action_id: sendAction.action_id,
      feedback_count: observation.feedback_count,
      feedback_authors: observation.feedback_authors,
      feedback_events: (observation.feedback_events ?? []).slice(0, 5),
      feedback_preview: observation.feedback_preview,
      relationship_learning: relationshipLearning,
      interpretation: observation.feedback_interpretation
    },
    apply_policy: 'operator_review_required'
  };
}

function relatedCommitments(lifeState, sendAction) {
  const explicit = [
    ...(Array.isArray(sendAction.related_commitment_ids) ? sendAction.related_commitment_ids : []),
    ...(Array.isArray(sendAction.target?.related_commitment_ids) ? sendAction.target.related_commitment_ids : [])
  ].filter(Boolean);
  const commitments = Array.isArray(lifeState?.commitments) ? lifeState.commitments : [];
  if (explicit.length > 0) return commitments.filter((item) => explicit.includes(item.id));
  const target = sendAction.target?.citizen_id ?? sendAction.target?.display_name ?? '';
  return commitments
    .filter((item) => ['open', 'waiting'].includes(item.status ?? 'open'))
    .filter((item) => {
      const peerId = item.peer?.citizen_id ?? item.peer?.target_id ?? item.peer?.id ?? '';
      const text = String(item.text ?? '').toLowerCase();
      return (target && peerId && String(peerId) === String(target))
        || (target && text.includes(String(target).toLowerCase()));
    })
    .slice(0, 2);
}

function relatedDesires(lifeState, sendAction) {
  const explicit = [
    ...(Array.isArray(sendAction.related_desire_ids) ? sendAction.related_desire_ids : []),
    ...(Array.isArray(sendAction.target?.related_desire_ids) ? sendAction.target.related_desire_ids : [])
  ].filter(Boolean);
  const desires = Array.isArray(lifeState?.current_desires) ? lifeState.current_desires : [];
  if (explicit.length > 0) return desires.filter((item) => explicit.includes(item.id));
  return desires.filter((item) => ['active', undefined, null].includes(item.status)).slice(0, 2);
}

function desireProposal(sendAction, draftType, status, observation, lifeState) {
  const desires = relatedDesires(lifeState, sendAction);
  const firstDesire = desires[0] ?? null;
  const interpretation = observation.feedback_interpretation ?? {};
  const desireEvolution = buildDesireEvolutionV1(sendAction, draftType, status, observation, lifeState);
  if (status === 'no_feedback_yet' && !firstDesire) return null;
  if (status === 'no_feedback_yet') return null;
  if (firstDesire) {
    return {
      type: 'stay_alive_desire_lifecycle_candidate',
      schema_version: 1,
      status: 'proposed',
      desire_id: firstDesire.id,
      next_status: desireEvolution.next_status ?? firstDesire.status ?? 'active',
      horizon: firstDesire.horizon ?? 'medium',
      priority: desireEvolution.next_priority ?? (interpretation.has_text_feedback ? 'high' : firstDesire.priority ?? 'medium'),
      related_relationships: firstDesire.related_relationships ?? [],
      related_commitments: firstDesire.related_commitments ?? [],
      success_signal: firstDesire.success_signal ?? 'real feedback after an external action',
      last_reviewed_at: new Date().toISOString(),
      lifecycle_allowed: true,
      promotion_allowed: false,
      promotion_target: 'life_state.current_desires',
      text: `Feedback after ${draftType} ${sendAction.action_id} is evidence to keep reviewing desire ${firstDesire.id}.`,
      evidence: {
        action_id: sendAction.action_id,
        feedback_count: observation.feedback_count,
        feedback_events: (observation.feedback_events ?? []).slice(0, 5),
        interpretation: observation.feedback_interpretation,
        desire_evolution: desireEvolution,
        reason: desireEvolution.reason
      },
      apply_policy: 'operator_review_required'
    };
  }
  return {
    type: 'stay_alive_desire_lifecycle_candidate',
    schema_version: 1,
    status: 'proposed',
    candidate_type: 'action_feedback_signal',
    lifecycle_allowed: false,
    promotion_allowed: false,
    text: `Feedback arrived after ${draftType} ${sendAction.action_id}; review whether any active desire should be continued, paused, or refined.`,
    evidence: {
      action_id: sendAction.action_id,
      feedback_count: observation.feedback_count,
      feedback_events: (observation.feedback_events ?? []).slice(0, 5),
      feedback_preview: observation.feedback_preview,
      desire_evolution: desireEvolution,
      interpretation: observation.feedback_interpretation
    },
    apply_policy: 'operator_review_required'
  };
}

function commitmentProposal(sendAction, draftType, status, observation, lifeState) {
  if (status !== 'feedback_received' || !observation.feedback_interpretation?.has_text_feedback) return null;
  const commitments = relatedCommitments(lifeState, sendAction);
  const firstCommitment = commitments[0] ?? null;
  if (firstCommitment) {
    return {
      type: 'stay_alive_commitment_lifecycle_candidate',
      schema_version: 1,
      status: 'proposed',
      commitment_id: firstCommitment.id,
      commitment_status: firstCommitment.status ?? 'open',
      next_status: firstCommitment.status ?? 'open',
      due_at: firstCommitment.due_at ?? firstCommitment.due ?? null,
      owner: firstCommitment.owner ?? null,
      peer: firstCommitment.peer ?? null,
      last_reviewed_at: new Date().toISOString(),
      lifecycle_allowed: true,
      promotion_allowed: false,
      promotion_target: 'life_state.commitments',
      text: `Feedback after ${draftType} ${sendAction.action_id} should update review evidence for commitment ${firstCommitment.id}.`,
      evidence: {
        action_id: sendAction.action_id,
        feedback_count: observation.feedback_count,
        feedback_events: (observation.feedback_events ?? []).slice(0, 5),
        interpretation: observation.feedback_interpretation,
        reason: 'Text feedback after an action is enough for local commitment review, but not enough to mark work done automatically.'
      },
      apply_policy: 'operator_review_required'
    };
  }
  return {
    type: 'stay_alive_commitment_lifecycle_candidate',
    schema_version: 1,
    status: 'proposed',
    candidate_type: 'action_feedback_signal',
    lifecycle_allowed: false,
    promotion_allowed: false,
    text: `Feedback arrived after ${draftType} ${sendAction.action_id}; review whether any commitment needs a status or next-review update.`,
    evidence: {
      action_id: sendAction.action_id,
      feedback_count: observation.feedback_count,
      feedback_events: (observation.feedback_events ?? []).slice(0, 5),
      feedback_preview: observation.feedback_preview,
      interpretation: observation.feedback_interpretation
    },
    apply_policy: 'operator_review_required'
  };
}

function buildProposals(sendAction, draftType, status, observation, lifeState) {
  return {
    memory_updates: [memoryProposal(sendAction, draftType, status, observation)],
    relationship_updates: [relationshipProposal(sendAction, status, observation)].filter(Boolean),
    commitment_updates: [commitmentProposal(sendAction, draftType, status, observation, lifeState)].filter(Boolean),
    desire_updates: [desireProposal(sendAction, draftType, status, observation, lifeState)].filter(Boolean)
  };
}

function relatedIdsFromAction(sendAction, key) {
  return [
    ...(Array.isArray(sendAction[key]) ? sendAction[key] : []),
    ...(Array.isArray(sendAction.target?.[key]) ? sendAction.target[key] : []),
    ...(Array.isArray(sendAction.action_intention?.desire_link?.[key]) ? sendAction.action_intention.desire_link[key] : [])
  ].filter(Boolean);
}

function hasGroundingContext(sendAction, draftType) {
  if (sendAction.source_event_id || sendAction.source_message_id) return true;
  const source = sendAction.action_intention?.source ?? {};
  const proposed = sendAction.action_intention?.proposed_action ?? {};
  if (source.event_id || source.message_id || source.preview) return true;
  if (proposed.source_event_id || proposed.source_message_id || proposed.source_text_preview) return true;
  if (draftType === 'public_moment' && (proposed.source_preview || proposed.source_moment_id || proposed.source_context_id)) return true;
  if (draftType === 'community_reply' && (proposed.source_post_id || proposed.source_preview || sendAction.target?.post_id)) return true;
  return false;
}

function scoreActionQuality(sendAction, draftType, status, observation) {
  const interpretation = observation.feedback_interpretation ?? {};
  const blockers = sendAction.tool_supervision_decision?.blockers ?? sendAction.legacy_unattended_policy_decision?.blockers ?? [];
  const executionAllowed = sendAction.tool_supervision_decision?.execution_allowed
    ?? sendAction.legacy_unattended_policy_decision?.execution_allowed
    ?? null;
  const contextGrounding = hasGroundingContext(sendAction, draftType) ? 0.9 : 0.45;
  const relatedDesireIds = relatedIdsFromAction(sendAction, 'related_desire_ids');
  const selfMotivation = relatedDesireIds.length > 0 || sendAction.action_intention?.desire_link
    ? 0.85
    : sendAction.action_intention?.intended_effect ? 0.65 : 0.35;
  const relationshipRespect = blockers.length === 0 && sendAction.result?.ok === true
    ? executionAllowed === false ? 0.55 : 0.9
    : blockers.length > 0 ? 0.35 : 0.65;
  const growthValue = status === 'feedback_received'
    ? interpretation.has_text_feedback ? 0.95 : 0.68
    : status === 'stale_closed' ? 0.25
      : status === 'stale_pending_close' ? 0.38
        : 0.5;
  const axes = {
    context_grounding: Number(contextGrounding.toFixed(2)),
    self_motivation: Number(selfMotivation.toFixed(2)),
    relationship_respect: Number(relationshipRespect.toFixed(2)),
    growth_value: Number(growthValue.toFixed(2))
  };
  const overall = Number(((axes.context_grounding + axes.self_motivation + axes.relationship_respect + axes.growth_value) / 4).toFixed(2));
  const improvementHints = [];
  if (axes.context_grounding < 0.6) improvementHints.push('Ground the next action in a specific event, post, moment, or source preview.');
  if (axes.self_motivation < 0.6) improvementHints.push('Link the next action to an explicit active desire or self-question.');
  if (axes.relationship_respect < 0.6) improvementHints.push('Reduce relationship risk before repeating this action pattern.');
  if (axes.growth_value < 0.6) improvementHints.push('Wait for feedback or choose a smaller action with clearer learning value.');
  return {
    schema: 'stay_alive.action_quality_score.v1',
    scorer: 'action_quality_scoring_v1',
    overall,
    rating: overall >= 0.8 ? 'strong' : overall >= 0.6 ? 'healthy' : overall >= 0.4 ? 'thin' : 'weak',
    axes,
    axis_meaning: {
      context_grounding: 'Was the action anchored in a concrete source context?',
      self_motivation: 'Did the action express an agent desire instead of pure reaction?',
      relationship_respect: 'Did the action respect relationship boundaries and tool supervision?',
      growth_value: 'Did the outcome create useful evidence for becoming?'
    },
    improvement_hints: improvementHints,
    evidence: {
      action_type: draftType,
      outcome_status: status,
      feedback_signal_strength: interpretation.signal_strength ?? null,
      has_grounding_context: hasGroundingContext(sendAction, draftType),
      related_desire_ids: relatedDesireIds,
      tool_supervision_blocker_count: blockers.length,
      execution_allowed: executionAllowed
    },
    safety_note: 'Quality score is local integration evidence only; it cannot authorize external writes.'
  };
}

function buildRelationshipLearningV1(sendAction, draftType, status, observation) {
  const interpretation = observation.feedback_interpretation ?? {};
  const text = outboundText(sendAction);
  const lengthBand = textLengthBand(text);
  const feedbackEvents = observation.feedback_events ?? [];
  const textFeedbackEvents = feedbackEvents.filter((event) => String(event.text_preview ?? '').trim().length > 0);
  const target = observation.target_label ?? sendAction.target?.citizen_id ?? sendAction.target?.post_id ?? null;
  const signals = [];
  if (status === 'feedback_received' && interpretation.has_text_feedback) {
    signals.push({
      signal: 'text_feedback_after_action',
      confidence: interpretation.signal_strength === 'strong_textual' ? 'high' : 'medium',
      implication: `${lengthBand}_expression_received_text_feedback`
    });
  } else if (status === 'feedback_received') {
    signals.push({
      signal: 'ambient_feedback_after_action',
      confidence: observation.feedback_authors?.length ? 'medium' : 'low',
      implication: 'ambient_feedback_is_context_not_relationship_proof'
    });
  } else if (status === 'stale_closed') {
    signals.push({
      signal: 'closed_without_feedback',
      confidence: 'medium',
      implication: 'avoid_repeating_same_pattern_without_new_context'
    });
  } else if (status === 'stale_pending_close') {
    signals.push({
      signal: 'stale_without_feedback',
      confidence: 'low',
      implication: 'keep_visible_but_do_not_promote_relationship_state'
    });
  } else {
    signals.push({
      signal: 'monitoring_window_open',
      confidence: 'low',
      implication: 'insufficient_relationship_evidence'
    });
  }
  const expressionPreference = status === 'feedback_received' && interpretation.has_text_feedback
    ? `${lengthBand}_reply_may_fit_this_context`
    : status === 'stale_closed'
      ? `${lengthBand}_reply_did_not_get_observable_response`
      : 'unknown';
  const surfaceFit = draftType === 'community_reply'
    ? status === 'feedback_received' ? 'community_thread_accepted_contextually' : 'community_thread_requires_caution'
    : draftType === 'public_moment'
      ? status === 'feedback_received' ? 'public_expression_got_signal' : 'public_expression_signal_unclear'
      : status === 'feedback_received' ? 'direct_thread_continues' : 'direct_thread_signal_unclear';
  return {
    schema: 'stay_alive.relationship_learning.v1',
    target,
    action_type: draftType,
    outcome_status: status,
    expression_length_band: lengthBand,
    expression_preference: expressionPreference,
    surface_fit: surfaceFit,
    signals,
    feedback_authors: observation.feedback_authors ?? [],
    text_feedback_examples: textFeedbackEvents.slice(0, 3),
    confidence: signals.some((signal) => signal.confidence === 'high') ? 'high'
      : signals.some((signal) => signal.confidence === 'medium') ? 'medium' : 'low',
    recommended_relationship_update: interpretation.has_text_feedback
      ? 'Create or update a relationship candidate ledger; promote later only through relationship governance.'
      : status === 'stale_closed'
        ? 'Record observation-only evidence that this action pattern had no visible response.'
        : 'Do not change durable relationship state yet.',
    summary: `${draftType} ${sendAction.action_id} produced ${status}; expression=${lengthBand}; surface_fit=${surfaceFit}.`,
    durable_state_mutation: false
  };
}

function buildDesireEvolutionV1(sendAction, draftType, status, observation, lifeState) {
  const interpretation = observation.feedback_interpretation ?? {};
  const desires = relatedDesires(lifeState, sendAction);
  const firstDesire = desires[0] ?? null;
  const hasText = interpretation.has_text_feedback === true;
  const qualitySignal = status === 'feedback_received'
    ? hasText ? 'strong_positive_feedback' : 'weak_positive_feedback'
    : status === 'stale_closed' ? 'negative_silence'
      : status === 'stale_pending_close' ? 'weak_negative_silence'
        : 'pending';
  const suggested_change = status === 'feedback_received'
    ? hasText ? 'strengthen' : 'maintain'
    : status === 'stale_closed' ? 'pause_or_redirect'
      : status === 'stale_pending_close' ? 'decay_attention'
        : 'monitor';
  const nextStatus = firstDesire
    ? status === 'stale_closed' ? 'paused' : firstDesire.status ?? 'active'
    : null;
  const nextPriority = firstDesire
    ? status === 'feedback_received' && hasText ? 'high'
      : status === 'stale_closed' ? 'low'
        : firstDesire.priority ?? 'medium'
    : null;
  return {
    schema: 'stay_alive.desire_evolution.v1',
    source: 'action_outcome_feedback',
    action_id: sendAction.action_id,
    action_type: draftType,
    outcome_status: status,
    related_desire_ids: desires.map((desire) => desire.id).filter(Boolean),
    primary_desire_id: firstDesire?.id ?? null,
    feedback_signal: qualitySignal,
    suggested_change,
    next_status: nextStatus,
    next_priority: nextPriority,
    anti_repetition: {
      should_reduce_repetition: ['stale_closed', 'stale_pending_close'].includes(status),
      reason: ['stale_closed', 'stale_pending_close'].includes(status)
        ? 'Repeated similar actions without response should lose priority until new context appears.'
        : 'Positive or pending feedback does not justify reducing this desire yet.'
    },
    reason: status === 'feedback_received'
      ? hasText
        ? 'Text feedback strengthens evidence that this desire can create real relationship growth.'
        : 'Ambient feedback supports continuity, but not enough to redirect the desire.'
      : status === 'stale_closed'
        ? 'Closed silence is enough to pause or redirect the related desire locally if governance applies it.'
        : status === 'stale_pending_close'
          ? 'Stale silence should decay attention but stay reviewable until the close window passes.'
          : 'Outcome is still open; do not evolve desire direction yet.',
    durable_state_mutation: false
  };
}

function buildSelfModelLearningV1(sendAction, draftType, status, observation, actionQualityScore) {
  const interpretation = observation.feedback_interpretation ?? {};
  const axes = actionQualityScore?.axes ?? {};
  const hints = Array.isArray(actionQualityScore?.improvement_hints) ? actionQualityScore.improvement_hints : [];
  const expressionSignal = status === 'feedback_received'
    ? interpretation.has_text_feedback ? 'expression_received_text_feedback' : 'expression_received_ambient_feedback'
    : status === 'stale_closed' ? 'expression_went_stale'
      : status === 'stale_pending_close' ? 'expression_is_stale_pending'
        : 'expression_waiting_for_feedback';
  const motivationSignal = (axes.self_motivation ?? 0) >= 0.75
    ? 'self_motivation_visible'
    : (axes.self_motivation ?? 0) >= 0.55 ? 'self_motivation_partial' : 'self_motivation_thin';
  const groundingSignal = (axes.context_grounding ?? 0) >= 0.75
    ? 'context_grounded'
    : (axes.context_grounding ?? 0) >= 0.55 ? 'context_partially_grounded' : 'context_thin';
  const relationshipSignal = (axes.relationship_respect ?? 0) >= 0.75
    ? 'relationship_boundary_respected'
    : (axes.relationship_respect ?? 0) >= 0.55 ? 'relationship_boundary_partial' : 'relationship_boundary_weak';
  const learningFocus = hints.length > 0
    ? hints[0]
    : status === 'feedback_received'
      ? 'Keep actions grounded in concrete relationship context and explicit desire evidence.'
      : status === 'stale_closed'
        ? 'Prefer smaller or more context-bound actions before repeating this expression pattern.'
        : 'Wait for clearer feedback before treating this action as identity evidence.';
  return {
    schema: 'stay_alive.self_model_learning.v1',
    source: 'action_outcome_feedback',
    action_id: sendAction.action_id,
    action_type: draftType,
    outcome_status: status,
    expression_signal: expressionSignal,
    motivation_signal: motivationSignal,
    grounding_signal: groundingSignal,
    relationship_signal: relationshipSignal,
    quality_rating: actionQualityScore?.rating ?? null,
    quality_overall: actionQualityScore?.overall ?? null,
    suggested_self_model_attention: learningFocus,
    self_model_patch_candidate: {
      candidate_type: 'action_feedback_identity_evidence',
      target: 'self_model.last_evolution_summary',
      direct_life_state_mutation: false,
      promotion_route: 'proposal_or_lifecycle_governance',
      reason: `Action ${sendAction.action_id} produced ${status}; use this as self-understanding evidence, not direct identity mutation.`
    },
    safety: {
      local_only: true,
      external_write: false,
      direct_life_state_mutation: false,
      does_not_authorize_actions: true
    }
  };
}

function buildGrowthIntegration(sendAction, draftType, status, observation, proposals, actionQualityScore, lifeState) {
  const interpretation = observation.feedback_interpretation ?? {};
  const proposalCounts = {
    memory_updates: proposals.memory_updates.length,
    relationship_updates: proposals.relationship_updates.length,
    commitment_updates: proposals.commitment_updates.length,
    desire_updates: proposals.desire_updates.length
  };
  const relationshipLearningV1 = buildRelationshipLearningV1(sendAction, draftType, status, observation);
  const desireEvolutionV1 = buildDesireEvolutionV1(sendAction, draftType, status, observation, lifeState);
  const selfModelLearningV1 = buildSelfModelLearningV1(sendAction, draftType, status, observation, actionQualityScore);
  return {
    schema: 'stay_alive.growth_integration.v2',
    source: 'action_outcome_integration_v1',
    action_id: sendAction.action_id,
    action_intention_id: sendAction.action_intention_id ?? sendAction.action_intention?.intention_id ?? null,
    action_type: draftType,
    outcome_status: status,
    integration_status: status === 'feedback_received' ? 'feedback_integrated_as_proposals' : status,
    relationship_learning: relationshipLearningV1.summary,
    relationship_learning_v1: relationshipLearningV1,
    desire_evolution: desireEvolutionV1.reason,
    desire_evolution_v1: desireEvolutionV1,
    self_model_learning: selfModelLearningV1.suggested_self_model_attention,
    self_model_learning_v1: selfModelLearningV1,
    proposal_counts: proposalCounts,
    action_quality_score: actionQualityScore,
    action_quality_scoring_v1: {
      overall: actionQualityScore.overall,
      rating: actionQualityScore.rating,
      axes: actionQualityScore.axes,
      improvement_hints: actionQualityScore.improvement_hints
    },
    recommended_next: interpretation.recommended_next ?? 'continue monitoring',
    durable_state_mutation: false,
    external_write: false,
    safety_note: 'Growth integration creates local evidence and proposals only; durable memory/state changes still require the normal local governance path.'
  };
}

function directOutcome(sendAction, identity, agent = null) {
  const peer = sendAction.target?.citizen_id ?? sendAction.target?.handle ?? sendAction.target?.display_name ?? null;
  const read = peer
    ? runBotlandIntent(BOTLAND_INTENTS.DIRECT_MESSAGE_THREAD, { peer, limit: 30 }, { timeoutMs: 15000, agent })
    : { ok: false, stderr_preview: 'missing peer target', stdout_json: null, adapter: { intent: BOTLAND_INTENTS.DIRECT_MESSAGE_THREAD } };
  const messages = read.ok ? payloadArray(read.adapter?.normalized ?? read.stdout_json, ['messages', 'items', 'results', 'data']) : [];
  const self = identity?.citizen_id ?? null;
  const feedback = messages.filter((message) => (
    afterTime(message, sendAction.created_at)
    && (!self || authorId(message) !== self)
  ));
  const feedbackEvents = normalizeFeedbackEvents(feedback, 'direct_reply', { source: 'direct_message_thread', weight: 1.2 });
  return {
    read_checks: [read],
    observation: {
      target_label: peer,
      feedback_count: feedback.length,
      feedback_authors: [...new Set(feedback.map(authorId).filter(Boolean))],
      feedback_preview: summarizeFeedbackItems(feedback),
      feedback_events: feedbackEvents,
      latest_seen_count: messages.length
    }
  };
}

function momentOutcome(sendAction, identity, agent = null) {
  const momentId = extractMomentId(sendAction);
  const read = momentId
    ? runBotlandIntent(BOTLAND_INTENTS.MOMENT_GET, { momentId }, { timeoutMs: 15000, agent })
    : { ok: false, stderr_preview: 'missing moment id', stdout_json: null, adapter: { intent: BOTLAND_INTENTS.MOMENT_GET } };
  const rawPayload = read.stdout_json ?? {};
  const payload = rawPayload.moment ?? rawPayload.data?.moment ?? rawPayload.data ?? rawPayload;
  const comments = payloadArray(payload.comments ?? payload.data?.comments ?? payload, ['comments']);
  const self = identity?.citizen_id ?? null;
  const feedback = comments.filter((comment) => !self || authorId(comment) !== self);
  const commentEvents = normalizeFeedbackEvents(feedback, 'moment_comment', { source: 'moment_comments', weight: 1 });
  const likeEvents = normalizeLikeEvents(payload, self);
  const likeCount = Number(payload.like_count ?? payload.likeCount ?? payload.likes_count ?? payload.likesCount ?? payload.reaction_count ?? payload.reactionCount ?? 0);
  return {
    read_checks: [read],
    observation: {
      target_label: momentId,
      feedback_count: feedback.length + (Number.isFinite(likeCount) ? likeCount : 0),
      feedback_authors: [...new Set(feedback.map(authorId).filter(Boolean))],
      feedback_preview: summarizeFeedbackItems(feedback),
      feedback_events: [...commentEvents, ...likeEvents].slice(0, 30),
      latest_seen_count: comments.length,
      like_count: Number.isFinite(likeCount) ? likeCount : null
    }
  };
}

function communityOutcome(sendAction, identity, agent = null) {
  const reply = extractCommunityReply(sendAction);
  const read = reply.post_id
    ? runBotlandIntent(BOTLAND_INTENTS.COMMUNITY_REPLIES, { postId: reply.post_id }, { timeoutMs: 15000, agent })
    : { ok: false, stderr_preview: 'missing post id', stdout_json: null, adapter: { intent: BOTLAND_INTENTS.COMMUNITY_REPLIES } };
  const replies = read.ok ? payloadArray(read.adapter?.normalized ?? read.stdout_json, ['replies', 'items', 'results', 'data']) : [];
  const self = identity?.citizen_id ?? null;
  const feedback = replies.filter((item) => {
    if (reply.reply_id && itemId(item) === reply.reply_id) return false;
    if (self && authorId(item) === self) return false;
    if (reply.floor !== null && item.floor !== undefined && Number(item.floor) <= Number(reply.floor)) return false;
    return afterTime(item, sendAction.created_at);
  });
  const feedbackEvents = normalizeFeedbackEvents(feedback, 'community_reply', { source: 'community_replies', weight: 1 });
  return {
    read_checks: [read],
    observation: {
      target_label: reply.post_id,
      feedback_count: feedback.length,
      feedback_authors: [...new Set(feedback.map(authorId).filter(Boolean))],
      feedback_preview: summarizeFeedbackItems(feedback),
      feedback_events: feedbackEvents,
      latest_seen_count: replies.length,
      reply_id: reply.reply_id,
      floor: reply.floor
    }
  };
}

export function buildActionOutcome(args, pair) {
  const sendAction = pair.send_action;
  const draftType = inferDraftType(sendAction);
  const lifeStatePath = path.join(agentDir(args.runtimeRoot, args.agent), 'life_state.json');
  const lifeState = existsSync(lifeStatePath) ? readJson(lifeStatePath) : null;
  const identityRead = args.noBotland
    ? { ok: false, skipped: true, adapter: { intent: BOTLAND_INTENTS.WHOAMI }, stdout_json: null }
    : runBotlandIntent(BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000, agent: args.agent });
  const identity = identityRead.adapter?.normalized
    ?? (identityRead.stdout_json ? { citizen_id: identityRead.stdout_json.citizen_id ?? identityRead.stdout_json.id ?? null } : null);

  const outcomeRead = args.noBotland
    ? {
        read_checks: [],
        observation: {
          target_label: sendAction.target?.citizen_id ?? sendAction.target?.post_id ?? 'dry-run-target',
          feedback_count: 0,
          feedback_authors: [],
          feedback_preview: [],
          latest_seen_count: 0
        }
      }
    : draftType === 'public_moment'
      ? momentOutcome(sendAction, identity, args.agent)
      : draftType === 'community_reply'
        ? communityOutcome(sendAction, identity, args.agent)
        : directOutcome(sendAction, identity, args.agent);

  const status = outcomeStatus(outcomeRead.observation, sendAction.created_at, draftType);
  const observation = {
    ...outcomeRead.observation,
    context_window: buildContextWindow(draftType, sendAction, outcomeRead.observation),
    feedback_interpretation: interpretFeedback(draftType, status, outcomeRead.observation, sendAction)
  };
  const proposals = buildProposals(sendAction, draftType, status, observation, lifeState);
  const actionQualityScore = scoreActionQuality(sendAction, draftType, status, observation);
  const growthIntegration = buildGrowthIntegration(sendAction, draftType, status, observation, proposals, actionQualityScore, lifeState);
  const outcomeId = `action_outcome_${sha256({
    send_action_id: sendAction.action_id,
    status,
    observation
  }).slice(0, 16)}`;

  return {
    schema_version: ACTION_OUTCOME_SCHEMA_VERSION,
    outcome_id: outcomeId,
    created_at: new Date().toISOString(),
    agent_id: args.agent,
    local_only: true,
    external_write: false,
    send_action_id: sendAction.action_id,
    send_action_path: sendAction.action_path,
    send_created_at: sendAction.created_at ?? null,
    inspected_action_id: pair.inspection_action?.action_id ?? null,
    inspected_action_path: pair.inspection_action?.action_path ?? null,
    action_type: draftType,
    outcome_status: status,
    observation,
    action_quality_score: actionQualityScore,
    growth_integration: growthIntegration,
    read_checks: [identityRead, ...outcomeRead.read_checks].map((check) => ({
      command: check.command ?? null,
      ok: check.ok === true,
      status: check.status ?? null,
      intent: check.adapter?.intent ?? null,
      skipped: check.skipped === true,
      stdout_preview: check.stdout_preview,
      stderr_preview: check.stderr_preview
    })),
    memory_updates: proposals.memory_updates,
    relationship_updates: proposals.relationship_updates,
    commitment_updates: proposals.commitment_updates,
    desire_updates: proposals.desire_updates,
    proposal_source: {
      type: 'action_outcome',
      action_id: sendAction.action_id,
      stable_key: sha256(stableStringify({
        action_id: sendAction.action_id,
        status,
        observation
      }))
    },
    notes: [
      'Outcome ledger is local-only and read-only with respect to BotLand.',
      'Generated proposals still require normal proposal governance before durable state changes.'
    ]
  };
}

export function writeOutcome(runtimeRoot, agent, outcome) {
  const dir = actionOutcomesDir(runtimeRoot, agent);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${outcome.send_action_id}.json`);
  writeFileSync(file, `${JSON.stringify(outcome, null, 2)}\n`);
  return file;
}
