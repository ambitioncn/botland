const POLICY_SCHEMA = 'stay_alive.tool_supervision_policy.v1';
const CAPABILITY_GRANTS_SCHEMA = 'stay_alive.capability_grants.v1';
const DEFAULT_BLOCKED_WRITE_TYPES = [];
const DEFAULT_ELIGIBLE_WRITE_TYPES = [
  'direct_message_reply',
  'public_moment',
  'community_reply',
  'community_post',
  'group_message',
  'friend_request',
  'friend_request_accept',
  'profile_update',
  'playground_action',
  'report',
  'moderation_action'
];
const DEFAULT_AUTONOMOUS_ACTION_TYPES = [
  'direct_message_reply',
  'public_moment',
  'community_reply',
  'community_post',
  'group_message',
  'friend_request',
  'friend_request_accept',
  'profile_update',
  'playground_action',
  'report',
  'moderation_action'
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasRelationshipForTarget(lifeState, target) {
  const relationships = Array.isArray(lifeState?.relationships) ? lifeState.relationships : [];
  const citizenId = target?.citizen_id ?? target?.target_citizen_id ?? null;
  if (!citizenId) return false;
  return relationships.some((relationship) => {
    return relationship?.botland?.citizen_id === citizenId
      || relationship?.citizen_id === citizenId
      || relationship?.target_id === citizenId;
  });
}

function containsLink(text) {
  return /https?:\/\/|www\./i.test(String(text ?? ''));
}

function containsSensitiveTopic(text) {
  return /\b(money|payment|password|token|secret|medical|legal|diagnosis|investment|银行卡|密码|令牌|付款|转账|医疗|法律|投资)\b/i.test(String(text ?? ''));
}

function containsInternalDraftLeak(text) {
  const value = String(text ?? '');
  return /\b(stay-alive|self-authored|read-only context|outward action|operator-reviewed|tool supervision|run-cycle|life_state|preflight)\b/i.test(value);
}

function parseTime(value) {
  if (!value) return null;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function minutesBetween(later, earlier) {
  if (later === null || earlier === null) return null;
  return (later - earlier) / 60000;
}

function preflightSafetyBlockers(safetyFindings) {
  const findings = Array.isArray(safetyFindings) ? safetyFindings : [];
  const blockers = [];
  if (findings.includes('uninspected_successful_send_detected')) {
    blockers.push('uninspected_successful_send_detected');
  }
  if (findings.includes('botland_bridge_identity_mismatch_detected')
    || findings.includes('life_state_botland_identity_error_detected')) {
    blockers.push('botland_identity_mismatch_detected');
  }
  return blockers;
}

export function defaultUnattendedPolicy() {
  return {
    schema_version: POLICY_SCHEMA,
    enabled: true,
    mode: 'active',
    default_decision: 'tool_supervision_required',
    eligible_write_types: DEFAULT_ELIGIBLE_WRITE_TYPES,
    blocked_write_types: DEFAULT_BLOCKED_WRITE_TYPES,
    global_limits: {
      external_writes_per_cycle: 1,
      max_unattended_writes_per_hour: 6,
      max_unattended_writes_per_day: 20,
      min_minutes_between_unattended_writes: 3
    },
    context_requirements: {
      require_existing_relationship: false,
      require_direct_inbound_event: false,
      require_direct_source_or_relationship: true,
      require_same_peer: true,
      require_low_sensitivity_text: true,
      max_text_length: 500,
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

export function defaultCapabilityGrants() {
  const grants = {};
  for (const type of DEFAULT_ELIGIBLE_WRITE_TYPES) {
    const enabled = DEFAULT_AUTONOMOUS_ACTION_TYPES.includes(type);
    grants[type] = {
      enabled,
      mode: enabled ? 'autonomous_policy_gate' : 'requires_capability_grant',
      human_confirmation_required: false,
      grant_source: enabled ? 'owner_authorized_default_capability_grant' : 'not_granted_by_default',
      gated_by: enabled
        ? [
            'preflight',
            'botland_identity_match',
            'tool_supervision_policy',
            'rate_limits',
            'duplicate_and_leakage_checks',
            'local_action_ledger',
            'post_send_inspection'
          ]
        : []
    };
  }
  return {
    schema_version: CAPABILITY_GRANTS_SCHEMA,
    grant_model: 'capability_grant_plus_autonomous_policy_gate',
    human_role: 'grant_or_revoke_capabilities_and_change_policy_boundaries_not_per_action_confirmation',
    grants
  };
}

export function normalizeCapabilityGrants(lifeState = {}) {
  const defaults = defaultCapabilityGrants();
  const configured = isObject(lifeState.capability_grants) ? lifeState.capability_grants : {};
  const configuredGrants = isObject(configured.grants) ? configured.grants : {};
  const grants = {};
  for (const type of DEFAULT_ELIGIBLE_WRITE_TYPES) {
    const value = isObject(configuredGrants[type]) ? configuredGrants[type] : {};
    grants[type] = {
      ...defaults.grants[type],
      ...value,
      gated_by: Array.isArray(value.gated_by) ? value.gated_by : defaults.grants[type].gated_by
    };
  }
  return {
    ...defaults,
    ...configured,
    schema_version: configured.schema_version ?? defaults.schema_version,
    grant_model: configured.grant_model ?? defaults.grant_model,
    human_role: configured.human_role ?? defaults.human_role,
    grants
  };
}

export function normalizeUnattendedPolicy(lifeState = {}) {
  const defaults = defaultUnattendedPolicy();
  if (!isObject(lifeState.unattended_write_policy)) return defaults;
  const policy = lifeState.unattended_write_policy;
  return {
    ...defaults,
    ...policy,
    global_limits: {
      ...defaults.global_limits,
      ...(isObject(policy.global_limits) ? policy.global_limits : {})
    },
    context_requirements: {
      ...defaults.context_requirements,
      ...(isObject(policy.context_requirements) ? policy.context_requirements : {})
    },
    circuit_breakers: {
      ...defaults.circuit_breakers,
      ...(isObject(policy.circuit_breakers) ? policy.circuit_breakers : {})
    },
    audit_requirements: {
      ...defaults.audit_requirements,
      ...(isObject(policy.audit_requirements) ? policy.audit_requirements : {})
    }
  };
}

export function validateUnattendedPolicy(lifeState = {}) {
  const policy = normalizeUnattendedPolicy(lifeState);
  const capabilityGrants = normalizeCapabilityGrants(lifeState);
  const issues = [];
  const add = (level, code, message) => issues.push({ level, code, message });

  if (policy.schema_version !== POLICY_SCHEMA) {
    add('error', 'unattended_policy_schema_invalid', `unattended_write_policy.schema_version must be ${POLICY_SCHEMA}`);
  }
  if (policy.enabled !== true) {
    add('error', 'tool_supervision_policy_disabled', 'Tool-supervised external writes must be enabled for autonomous BotLand use');
  }
  if (policy.mode !== 'active') {
    add('error', 'tool_supervision_policy_mode_not_active', 'Tool supervision policy must run in active mode');
  }
  if (policy.default_decision !== 'tool_supervision_required') {
    add('error', 'unattended_policy_default_decision_unsafe', 'Default decision must remain tool_supervision_required');
  }

  if (capabilityGrants.schema_version !== CAPABILITY_GRANTS_SCHEMA) {
    add('error', 'capability_grants_schema_invalid', `capability_grants.schema_version must be ${CAPABILITY_GRANTS_SCHEMA}`);
  }
  if (capabilityGrants.grant_model !== 'capability_grant_plus_autonomous_policy_gate') {
    add('error', 'capability_grant_model_invalid', 'capability_grants.grant_model must be capability_grant_plus_autonomous_policy_gate');
  }

  const eligible = Array.isArray(policy.eligible_write_types) ? policy.eligible_write_types : [];
  if (eligible.length === 0) add('error', 'tool_supervision_policy_no_eligible_types', 'Policy must document BotLand action types it can supervise');
  for (const type of eligible) {
    if (!DEFAULT_ELIGIBLE_WRITE_TYPES.includes(type)) {
      add('error', 'tool_supervision_policy_eligible_type_unknown', `Unknown tool-supervised write type: ${type}`);
      continue;
    }
    const grant = capabilityGrants.grants[type];
    if (!isObject(grant)) {
      add('error', 'capability_grant_missing', `capability grant missing for ${type}`);
      continue;
    }
    if (grant.human_confirmation_required !== false) {
      add('error', 'capability_grant_human_confirmation_required', `capability grant ${type} must not require per-action human confirmation`);
    }
    if (grant.enabled === true && grant.mode !== 'autonomous_policy_gate') {
      add('error', 'capability_grant_mode_invalid', `enabled capability grant ${type} must use autonomous_policy_gate mode`);
    }
    if (grant.enabled === true) {
      const gatedBy = Array.isArray(grant.gated_by) ? grant.gated_by : [];
      for (const gate of ['preflight', 'botland_identity_match', 'tool_supervision_policy', 'local_action_ledger', 'post_send_inspection']) {
        if (!gatedBy.includes(gate)) {
          add('error', 'capability_grant_gate_missing', `enabled capability grant ${type} must include gate ${gate}`);
        }
      }
    }
  }

  const blocked = Array.isArray(policy.blocked_write_types) ? policy.blocked_write_types : [];
  for (const type of blocked) {
    if (DEFAULT_ELIGIBLE_WRITE_TYPES.includes(type)) {
      add('error', 'tool_supervision_policy_blocks_botland_surface', `BotLand action type should be supervised instead of blocked: ${type}`);
    }
  }

  const limits = isObject(policy.global_limits) ? policy.global_limits : {};
  const limitCaps = {
    external_writes_per_cycle: 1,
    max_unattended_writes_per_hour: 6,
    max_unattended_writes_per_day: 20
  };
  for (const [field, cap] of Object.entries(limitCaps)) {
    if (!Number.isInteger(limits[field]) || limits[field] < 0 || limits[field] > cap) {
      add('error', 'tool_supervision_policy_limit_invalid', `global_limits.${field} must be an integer between 0 and ${cap}`);
    }
  }
  if (!Number.isInteger(limits.min_minutes_between_unattended_writes) || limits.min_minutes_between_unattended_writes < 3) {
    add('error', 'tool_supervision_policy_cooldown_too_low', 'min_minutes_between_unattended_writes must be at least 3 in v1.1');
  }

  const requirements = isObject(policy.context_requirements) ? policy.context_requirements : {};
  for (const field of [
    'require_direct_source_or_relationship',
    'require_same_peer',
    'require_low_sensitivity_text',
    'disallow_links',
    'disallow_attachments'
  ]) {
    if (requirements[field] !== true) {
      add('error', 'unattended_policy_context_requirement_missing', `context_requirements.${field} must be true`);
    }
  }
  if (!Number.isInteger(requirements.max_text_length) || requirements.max_text_length > 500) {
    add('error', 'unattended_policy_max_text_too_high', 'context_requirements.max_text_length must be <= 500');
  }

  const breakers = isObject(policy.circuit_breakers) ? policy.circuit_breakers : {};
  for (const field of [
    'require_preflight_pass',
    'stop_on_any_safety_finding',
    'stop_on_uninspected_successful_send',
    'stop_on_recent_failed_send',
    'stop_on_identity_mismatch',
    'stop_on_policy_drift',
    'control_pause_is_kill_switch'
  ]) {
    if (breakers[field] !== true) {
      add('error', 'unattended_policy_circuit_breaker_missing', `circuit_breakers.${field} must be true`);
    }
  }

  const audit = isObject(policy.audit_requirements) ? policy.audit_requirements : {};
  for (const field of ['write_action_ledger', 'inspect_after_send_required', 'record_policy_decision', 'rollback_by_policy_disable']) {
    if (audit[field] !== true) {
      add('error', 'unattended_policy_audit_requirement_missing', `audit_requirements.${field} must be true`);
    }
  }

  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  return {
    schema: POLICY_SCHEMA,
    policy,
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    enabled_count: policy.enabled === true ? 1 : 0,
    capability_grants: capabilityGrants,
    capability_grant_enabled_count: Object.values(capabilityGrants.grants).filter((grant) => grant.enabled === true).length,
    issue_count: issues.length,
    errors,
    warnings
  };
}

export function evaluateUnattendedDraft({ lifeState = {}, draft = {}, preflightGate = null } = {}) {
  const validation = validateUnattendedPolicy(lifeState);
  const policy = validation.policy;
  const capabilityGrants = validation.capability_grants;
  const reasons = [];
  const blockers = [];
  const addBlocker = (code) => blockers.push(code);

  if (validation.pass !== true) addBlocker('policy_invalid');
  if (policy.enabled !== true) addBlocker('policy_disabled');
  if (policy.mode !== 'active') addBlocker('policy_not_active');

  const type = draft.type ?? null;
  if (!policy.eligible_write_types.includes(type)) addBlocker('write_type_not_eligible');
  if (policy.blocked_write_types.includes(type)) addBlocker('write_type_blocked');
  const grant = capabilityGrants.grants[type];
  if (!grant || grant.enabled !== true) addBlocker('capability_grant_missing_or_disabled');
  if (grant?.mode !== 'autonomous_policy_gate') addBlocker('capability_grant_not_autonomous_policy_gate');
  if (grant?.human_confirmation_required !== false) addBlocker('capability_grant_requires_human_confirmation');

  if (draft.external_write === true) addBlocker('draft_already_external_write');
  if (draft.ready_for_send !== true) addBlocker('not_ready_for_send');
  const hasDirectSource = Boolean(draft.source_event_id || draft.source_message_id);
  const hasExistingRelationship = hasRelationshipForTarget(lifeState, draft.target);
  if (type === 'direct_message_reply' && policy.context_requirements.require_direct_inbound_event && !hasDirectSource) {
    addBlocker('direct_inbound_event_missing');
  }
  if (type === 'direct_message_reply'
    && policy.context_requirements.require_direct_source_or_relationship
    && !hasDirectSource
    && !hasExistingRelationship) {
    addBlocker('direct_message_context_missing');
  }
  if (type === 'direct_message_reply' && !draft.target?.citizen_id) addBlocker('target_citizen_missing');
  if (type === 'direct_message_reply'
    && policy.context_requirements.require_same_peer
    && draft.source_actor_citizen_id
    && draft.target?.citizen_id
    && draft.source_actor_citizen_id !== draft.target.citizen_id) {
    addBlocker('source_target_peer_mismatch');
  }
  if (type === 'direct_message_reply' && policy.context_requirements.require_existing_relationship && !hasExistingRelationship) {
    addBlocker('existing_relationship_missing');
  }
  if (type === 'public_moment' && draft.target?.visibility !== 'public') {
    addBlocker('public_moment_visibility_invalid');
  }
  if (type === 'public_moment' && draft.target?.surface && draft.target.surface !== 'botland_moments') {
    addBlocker('public_moment_surface_invalid');
  }
  if (type === 'public_moment' && !String(draft.source_event_id ?? '').match(/^(moment|social):/)) {
    addBlocker('public_moment_social_context_missing');
  }
  if (type === 'public_moment' && !String(draft.source_text_preview ?? '').trim()) {
    addBlocker('public_moment_source_preview_missing');
  }
  if (type === 'community_reply' && draft.target?.surface !== 'botland_community') {
    addBlocker('community_reply_surface_invalid');
  }
  if (type === 'community_reply' && !draft.target?.post_id) {
    addBlocker('community_reply_post_missing');
  }
  if (type === 'community_reply' && !String(draft.source_event_id ?? '').match(/^community_post:/)) {
    addBlocker('community_reply_source_context_missing');
  }
  if (type === 'community_reply' && !String(draft.source_text_preview ?? '').trim()) {
    addBlocker('community_reply_source_preview_missing');
  }
  if (type === 'friend_request_accept' && !draft.target?.request_id) {
    addBlocker('friend_request_id_missing');
  }
  if (type === 'friend_request_accept' && !draft.target?.citizen_id) {
    addBlocker('friend_request_actor_missing');
  }
  if (type === 'friend_request_accept' && !String(draft.source_event_id ?? '').match(/^friend_request:/)) {
    addBlocker('friend_request_source_context_missing');
  }
  if (type === 'friend_request_accept' && draft.target?.direction && draft.target.direction !== 'incoming') {
    addBlocker('friend_request_direction_invalid');
  }

  const text = String(draft.draft_text ?? '');
  if (!text.trim()) addBlocker('draft_text_missing');
  if (text.length > policy.context_requirements.max_text_length) addBlocker('draft_text_too_long');
  if (policy.context_requirements.disallow_links && containsLink(text)) addBlocker('draft_text_contains_link');
  if (policy.context_requirements.require_low_sensitivity_text && containsSensitiveTopic(text)) {
    addBlocker('draft_text_sensitive_topic');
  }
  if (type === 'public_moment' && containsInternalDraftLeak(text)) {
    addBlocker('public_moment_internal_draft_text');
  }
  if (draft.attachments || draft.media || draft.file) addBlocker('attachments_not_allowed');

  const duplicateRisk = draft.duplicate_risk === true
    || draft.safety_context?.duplicate_interaction === true
    || draft.safety_context?.repeat_contact_risk === true;
  if (duplicateRisk) addBlocker('duplicate_interaction_risk');

  const draftTime = parseTime(draft.created_at ?? draft.generated_at ?? draft.timestamp ?? new Date().toISOString());
  const lastExternalWriteTime = parseTime(lifeState.rate_limits?.last_external_write_at);
  const cooldownMinutes = policy.global_limits.min_minutes_between_unattended_writes;
  const elapsedMinutes = minutesBetween(draftTime, lastExternalWriteTime);
  if (policy.circuit_breakers.stop_on_recent_failed_send
    && Number.isFinite(elapsedMinutes)
    && elapsedMinutes >= 0
    && elapsedMinutes < cooldownMinutes) {
    addBlocker('recent_external_write_cooldown_active');
  }

  if (preflightGate) {
    if (preflightGate.pass !== true || preflightGate.ok !== true) addBlocker('preflight_not_pass');
    if (Array.isArray(preflightGate.safety_findings) && preflightGate.safety_findings.length > 0) {
      addBlocker('preflight_safety_findings');
      for (const blocker of preflightSafetyBlockers(preflightGate.safety_findings)) addBlocker(blocker);
    }
  } else {
    addBlocker('preflight_gate_missing');
  }

  if (blockers.length === 0) {
    reasons.push('Tool supervision allowed this BotLand action under active policy gates.');
  } else {
    reasons.push('Tool supervision blocked this BotLand action.');
  }

  const decision = {
    schema: 'stay_alive.tool_supervision_decision.v1',
    generated_at: new Date().toISOString(),
    decision: blockers.length === 0 ? 'allow_execute' : 'tool_supervision_required',
    execution_allowed: blockers.length === 0,
    tool_supervision_required: true,
    capability_grant: grant
      ? {
          type,
          enabled: grant.enabled === true,
          mode: grant.mode ?? null,
          human_confirmation_required: grant.human_confirmation_required ?? null,
          grant_source: grant.grant_source ?? null,
          gated_by: Array.isArray(grant.gated_by) ? grant.gated_by : []
        }
      : null,
    policy_enabled: policy.enabled === true,
    policy_mode: policy.mode,
    write_type: type,
    blockers,
    reasons,
    validation: {
      pass: validation.pass,
      level: validation.level,
      error_count: validation.error_count,
      warning_count: validation.warning_count
    }
  };
  return {
    ...decision,
    legacy_schema: 'stay_alive.unattended_write_decision.v1'
  };
}
