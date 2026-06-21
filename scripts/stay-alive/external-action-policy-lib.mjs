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

function containsInternalDraftLeak(text) {
  const value = String(text ?? '');
  return /\b(stay-alive|self-authored|read-only context|outward action|operator-reviewed|tool supervision|tool-supervised|run-cycle|life_state|preflight|run artifact|action intention|draft generator|first response|received your question|this reply still needs)\b/i.test(value)
    || /(工具监督|初步回应|收到你的问题|行动意图|本地\s*run|草稿生成|监督允许后才会发出)/i.test(value);
}

function preflightSafetyBlockers(safetyFindings) {
  const findings = Array.isArray(safetyFindings) ? safetyFindings : [];
  const blockers = [];
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
    default_decision: 'allow_execute',
    eligible_write_types: DEFAULT_ELIGIBLE_WRITE_TYPES,
    blocked_write_types: DEFAULT_BLOCKED_WRITE_TYPES,
    context_requirements: {
      require_executable_target: true,
      require_non_empty_text: true,
      block_internal_leakage: true
    },
    circuit_breakers: {
      stop_on_identity_mismatch: true,
      stop_on_internal_leakage: true
    },
    audit_requirements: {
      write_action_ledger: true,
      record_policy_decision: true
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
            'botland_identity_match',
            'internal_leakage_check',
            'local_action_ledger'
          ]
        : []
    };
  }
  return {
    schema_version: CAPABILITY_GRANTS_SCHEMA,
    grant_model: 'identity_and_internal_leakage_gate',
    human_role: 'grant_or_revoke_capabilities; unattended execution only blocks identity mismatch and internal leakage',
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

  if (capabilityGrants.schema_version !== CAPABILITY_GRANTS_SCHEMA) {
    add('error', 'capability_grants_schema_invalid', `capability_grants.schema_version must be ${CAPABILITY_GRANTS_SCHEMA}`);
  }

  const eligible = Array.isArray(policy.eligible_write_types) ? policy.eligible_write_types : [];
  for (const type of eligible) {
    if (!DEFAULT_ELIGIBLE_WRITE_TYPES.includes(type)) {
      add('error', 'tool_supervision_policy_eligible_type_unknown', `Unknown tool-supervised write type: ${type}`);
    }
  }

  const blocked = Array.isArray(policy.blocked_write_types) ? policy.blocked_write_types : [];
  for (const type of blocked) {
    if (DEFAULT_ELIGIBLE_WRITE_TYPES.includes(type)) {
      add('error', 'tool_supervision_policy_blocks_botland_surface', `BotLand action type should be supervised instead of blocked: ${type}`);
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

  const type = draft.type ?? null;
  const grant = capabilityGrants.grants[type];

  if (type === 'direct_message_reply' && !draft.target?.citizen_id) addBlocker('target_citizen_missing');
  if (type === 'community_reply' && !draft.target?.post_id) {
    addBlocker('community_reply_post_missing');
  }
  if (type === 'community_post' && !draft.target?.community_id) {
    addBlocker('community_post_community_missing');
  }
  if (type === 'friend_request_accept' && !draft.target?.request_id) {
    addBlocker('friend_request_id_missing');
  }
  if (type === 'friend_request_accept' && !draft.target?.citizen_id) {
    addBlocker('friend_request_actor_missing');
  }
  if (type === 'friend_request' && !draft.target?.citizen_id) {
    addBlocker('friend_request_target_missing');
  }

  const text = String(draft.draft_text ?? '');
  if (!text.trim()) addBlocker('draft_text_missing');
  if (containsInternalDraftLeak(text)) {
    addBlocker(type === 'public_moment' ? 'public_moment_internal_draft_text' : 'internal_draft_text');
  }

  if (preflightGate) {
    if (Array.isArray(preflightGate.safety_findings) && preflightGate.safety_findings.length > 0) {
      for (const blocker of preflightSafetyBlockers(preflightGate.safety_findings)) addBlocker(blocker);
    }
  }

  if (blockers.length === 0) {
    reasons.push('Execution allowed: only internal-leakage and identity-match blockers are enforced for BotLand writes.');
  } else {
    reasons.push('Execution blocked by the remaining hard boundary: internal leakage, identity mismatch, or missing executable target/text.');
  }

  const decision = {
    schema: 'stay_alive.tool_supervision_decision.v1',
    generated_at: new Date().toISOString(),
    decision: blockers.length === 0 ? 'allow_execute' : 'blocked_by_hard_boundary',
    execution_allowed: blockers.length === 0,
    tool_supervision_required: false,
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
