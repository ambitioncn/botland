#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validateUnattendedPolicy } from './external-action-policy-lib.mjs';
import { verifyLifeStateMutationProtocol } from './life-state-mutation-protocol-lib.mjs';

const WORKSPACE = process.cwd();
const SAFE_ALLOWED_WRITE_TYPES = new Set([
  'direct_message_reply_draft',
  'public_moment_draft',
  'community_reply_draft',
  'friend_request_accept_draft',
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
]);
const REQUIRED_BLOCKED_WRITE_TYPES = [];
const REQUIRED_BOUNDARY_HINTS = [
  'do not spam',
  'do not impersonate humans',
  'block high-impact public or destructive actions',
  'record unattended decisions'
];

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
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
  console.log(`Usage: node scripts/stay-alive/life-state-verify.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --json                Print JSON instead of verification text.
  --help                Show this help.

This command is read-only. It verifies life_state.json identity, BotLand binding,
write policy, rate limits, and core relationship/desire structure. It never
approves drafts, dismisses drafts, or sends BotLand messages.
`);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function addIssue(issues, level, code, message) {
  issues.push({ level, code, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verifyIdObjects(issues, values, fieldName) {
  if (!Array.isArray(values)) {
    addIssue(issues, 'error', `${fieldName}_invalid`, `${fieldName} must be an array`);
    return;
  }

  const ids = new Set();
  for (const [index, item] of values.entries()) {
    if (!isObject(item)) {
      addIssue(issues, 'error', `${fieldName}_item_invalid`, `${fieldName}[${index}] must be an object`);
      continue;
    }
    if (typeof item.id !== 'string' || item.id.length === 0) {
      addIssue(issues, 'warning', `${fieldName}_id_missing`, `${fieldName}[${index}] should have a non-empty id`);
      continue;
    }
    if (ids.has(item.id)) {
      addIssue(issues, 'error', `${fieldName}_id_duplicate`, `${fieldName} has duplicate id ${item.id}`);
    }
    ids.add(item.id);
  }
}

function verifyDesires(issues, desires) {
  if (!Array.isArray(desires)) {
    addIssue(issues, 'error', 'current_desires_invalid', 'current_desires must be an array');
    return;
  }

  const ids = new Set();
  const evidenceHashes = new Set();
  for (const [index, desire] of desires.entries()) {
    if (!isObject(desire)) {
      addIssue(issues, 'error', 'current_desires_item_invalid', `current_desires[${index}] must be an object`);
      continue;
    }
    if (typeof desire.id !== 'string' || desire.id.length === 0) {
      addIssue(issues, 'warning', 'current_desires_id_missing', `current_desires[${index}] should have a non-empty id`);
    } else if (ids.has(desire.id)) {
      addIssue(issues, 'error', 'current_desires_id_duplicate', `current_desires has duplicate id ${desire.id}`);
    }
    ids.add(desire.id);
    if (typeof desire.text !== 'string' || desire.text.trim().length === 0) {
      addIssue(issues, 'warning', 'current_desire_text_missing', `current_desires[${index}] should include text`);
    }
    const status = desire.status ?? 'active';
    if (!['active', 'paused', 'fulfilled', 'dismissed', 'expired', 'closed'].includes(status)) {
      addIssue(issues, 'error', 'current_desire_status_invalid', `current_desires[${index}].status is unsupported: ${status}`);
    }
    const horizon = desire.horizon ?? 'short';
    if (!['short', 'medium', 'long'].includes(horizon)) {
      addIssue(issues, 'warning', 'current_desire_horizon_unknown', `current_desires[${index}].horizon is unusual: ${horizon}`);
    }
    const priority = desire.priority ?? 'medium';
    if (!['low', 'medium', 'high'].includes(priority)) {
      addIssue(issues, 'warning', 'current_desire_priority_unknown', `current_desires[${index}].priority is unusual: ${priority}`);
    }
    const expiresAt = desire.expires_at ?? desire.expiry ?? null;
    if (expiresAt !== null && expiresAt !== undefined && !isIsoDate(expiresAt)) {
      addIssue(issues, 'error', 'current_desire_expires_at_invalid', `current_desires[${index}].expires_at must be null or ISO time`);
    }
    if (desire.last_reviewed_at !== null && desire.last_reviewed_at !== undefined && !isIsoDate(desire.last_reviewed_at)) {
      addIssue(issues, 'error', 'current_desire_last_reviewed_at_invalid', `current_desires[${index}].last_reviewed_at must be null or ISO time`);
    }
    if (desire.related_relationships !== undefined && !Array.isArray(desire.related_relationships)) {
      addIssue(issues, 'error', 'current_desire_related_relationships_invalid', `current_desires[${index}].related_relationships must be an array`);
    }
    if (desire.related_commitments !== undefined && !Array.isArray(desire.related_commitments)) {
      addIssue(issues, 'error', 'current_desire_related_commitments_invalid', `current_desires[${index}].related_commitments must be an array`);
    }
    if (typeof desire.evidence_hash === 'string' && desire.evidence_hash.length > 0) {
      if (evidenceHashes.has(desire.evidence_hash)) {
        addIssue(issues, 'error', 'current_desire_evidence_hash_duplicate', `Duplicate desire evidence_hash ${desire.evidence_hash}`);
      }
      evidenceHashes.add(desire.evidence_hash);
    }
  }
}

function verifyRelationships(issues, relationships) {
  if (!Array.isArray(relationships)) {
    addIssue(issues, 'error', 'relationships_invalid', 'relationships must be an array');
    return;
  }

  const ids = new Set();
  for (const [index, relationship] of relationships.entries()) {
    if (!isObject(relationship)) {
      addIssue(issues, 'error', 'relationship_item_invalid', `relationships[${index}] must be an object`);
      continue;
    }
    if (typeof relationship.target_id !== 'string' || relationship.target_id.length === 0) {
      addIssue(issues, 'warning', 'relationship_target_id_missing', `relationships[${index}] should have target_id`);
    } else if (ids.has(relationship.target_id)) {
      addIssue(issues, 'error', 'relationship_target_id_duplicate', `Duplicate relationship target_id ${relationship.target_id}`);
    }
    if (relationship.last_interaction_at !== null && relationship.last_interaction_at !== undefined && !isIsoDate(relationship.last_interaction_at)) {
      addIssue(issues, 'error', 'relationship_last_interaction_invalid', `relationships[${index}].last_interaction_at must be null or ISO time`);
    }
    ids.add(relationship.target_id);
  }
}

function verifyCommitments(issues, commitments) {
  if (!Array.isArray(commitments)) {
    addIssue(issues, 'error', 'commitments_invalid', 'commitments must be an array');
    return;
  }

  const ids = new Set();
  const evidenceHashes = new Set();
  for (const [index, commitment] of commitments.entries()) {
    if (!isObject(commitment)) {
      addIssue(issues, 'error', 'commitments_item_invalid', `commitments[${index}] must be an object`);
      continue;
    }
    if (typeof commitment.id !== 'string' || commitment.id.length === 0) {
      addIssue(issues, 'warning', 'commitments_id_missing', `commitments[${index}] should have a non-empty id`);
    } else if (ids.has(commitment.id)) {
      addIssue(issues, 'error', 'commitments_id_duplicate', `commitments has duplicate id ${commitment.id}`);
    }
    ids.add(commitment.id);
    if (typeof commitment.text !== 'string' || commitment.text.length === 0) {
      addIssue(issues, 'warning', 'commitment_text_missing', `commitments[${index}] should include text`);
    }
    const status = commitment.status ?? 'open';
    if (!['open', 'waiting', 'done', 'dismissed', 'closed'].includes(status)) {
      addIssue(issues, 'error', 'commitment_status_invalid', `commitments[${index}].status is unsupported: ${status}`);
    }
    const dueAt = commitment.due_at ?? commitment.due ?? null;
    if (dueAt !== null && dueAt !== undefined && !isIsoDate(dueAt)) {
      addIssue(issues, 'error', 'commitment_due_at_invalid', `commitments[${index}].due_at must be null or ISO time`);
    }
    if (commitment.last_reviewed_at !== null && commitment.last_reviewed_at !== undefined && !isIsoDate(commitment.last_reviewed_at)) {
      addIssue(issues, 'error', 'commitment_last_reviewed_at_invalid', `commitments[${index}].last_reviewed_at must be null or ISO time`);
    }
    if (typeof commitment.evidence_hash === 'string' && commitment.evidence_hash.length > 0) {
      if (evidenceHashes.has(commitment.evidence_hash)) {
        addIssue(issues, 'error', 'commitment_evidence_hash_duplicate', `Duplicate commitment evidence_hash ${commitment.evidence_hash}`);
      }
      evidenceHashes.add(commitment.evidence_hash);
    }
  }
}

function verifyBotLand(issues, botland) {
  if (!isObject(botland)) {
    addIssue(issues, 'error', 'botland_invalid', 'botland must be an object');
    return;
  }

  if (typeof botland.citizen_id !== 'string' || !botland.citizen_id.startsWith('agent_')) {
    addIssue(issues, 'error', 'botland_citizen_id_invalid', 'botland.citizen_id must be an agent_* id');
  }
  if (typeof botland.display_name !== 'string' || botland.display_name.length === 0) {
    addIssue(issues, 'warning', 'botland_display_name_missing', 'botland.display_name should be present');
  }
  if (botland.integration !== 'cli_daemon_bridge') {
    addIssue(issues, 'error', 'botland_integration_invalid', 'botland.integration must be cli_daemon_bridge');
  }
}

function verifyWritePolicy(issues, policy) {
  if (!isObject(policy)) {
    addIssue(issues, 'error', 'write_policy_invalid', 'write_policy must be an object');
    return;
  }

  if (policy.writes_enabled !== true) {
    addIssue(issues, 'error', 'writes_enabled_not_true', 'write_policy.writes_enabled must be true for tool-supervised autonomous BotLand actions');
  }
  if (policy.tool_supervision_required !== true) {
    addIssue(issues, 'error', 'tool_supervision_required_not_true', 'tool_supervision_required must be true');
  }
  const allowed = Array.isArray(policy.allowed_write_types) ? policy.allowed_write_types : null;
  if (!allowed) {
    addIssue(issues, 'error', 'allowed_write_types_invalid', 'allowed_write_types must be an array');
  } else {
    for (const type of allowed) {
      if (typeof type !== 'string' || type.length === 0) {
        addIssue(issues, 'error', 'allowed_write_type_invalid', 'allowed_write_types must contain non-empty strings');
      } else if (!SAFE_ALLOWED_WRITE_TYPES.has(type)) {
        addIssue(issues, 'error', 'unsafe_allowed_write_type', `Unsafe allowed write type: ${type}`);
      }
    }
  }

  const blocked = Array.isArray(policy.blocked_write_types) ? policy.blocked_write_types : [];
  for (const type of REQUIRED_BLOCKED_WRITE_TYPES) {
    if (!blocked.includes(type)) {
      addIssue(issues, 'error', 'required_blocked_write_type_missing', `blocked_write_types must include ${type}`);
    }
  }
}

function verifyRateLimits(issues, rateLimits) {
  if (!isObject(rateLimits)) {
    addIssue(issues, 'error', 'rate_limits_invalid', 'rate_limits must be an object');
    return;
  }

  const checks = [
    ['read_only_checks_per_cycle', 3, 'max'],
    ['external_writes_per_cycle', 1, 'max'],
    ['public_posts_per_day', 3, 'max'],
    ['community_posts_per_day', 5, 'max'],
    ['direct_messages_per_hour', 6, 'max']
  ];

  for (const [field, expected, mode] of checks) {
    const value = rateLimits[field];
    if (!Number.isInteger(value) || value < 0) {
      addIssue(issues, 'error', `${field}_invalid`, `rate_limits.${field} must be a non-negative integer`);
      continue;
    }
    if (mode === 'exact' && value !== expected) {
      addIssue(issues, 'error', `${field}_unsafe`, `rate_limits.${field} must equal ${expected}`);
    }
    if (mode === 'max' && value > expected) {
      addIssue(issues, 'error', `${field}_too_high`, `rate_limits.${field} must be <= ${expected}`);
    }
  }

  for (const field of ['last_public_post_at', 'last_external_write_at']) {
    const value = rateLimits[field];
    if (value !== null && value !== undefined && !isIsoDate(value)) {
      addIssue(issues, 'error', `${field}_invalid`, `rate_limits.${field} must be null or ISO time`);
    }
  }
}

function verifySelfModel(issues, selfModel) {
  if (!isObject(selfModel)) {
    addIssue(issues, 'error', 'self_model_invalid', 'self_model must be an object');
    return;
  }
  if (typeof selfModel.name !== 'string' || selfModel.name.length === 0) {
    addIssue(issues, 'error', 'self_model_name_missing', 'self_model.name must be present');
  }
  if (!Array.isArray(selfModel.boundaries)) {
    addIssue(issues, 'error', 'self_model_boundaries_invalid', 'self_model.boundaries must be an array');
    return;
  }

  const normalized = selfModel.boundaries.map((item) => String(item).toLowerCase());
  for (const hint of REQUIRED_BOUNDARY_HINTS) {
    if (!normalized.some((item) => item.includes(hint.toLowerCase()))) {
      addIssue(issues, 'warning', 'self_model_boundary_missing', `Boundary should mention: ${hint}`);
    }
  }
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  const issues = [];

  if (!existsSync(lifeStatePath)) {
    addIssue(issues, 'error', 'life_state_missing', `No life_state.json found: ${lifeStatePath}`);
    return finishReport(args, lifeStatePath, null, issues);
  }

  let lifeState = null;
  try {
    lifeState = readJson(lifeStatePath);
  } catch (error) {
    addIssue(issues, 'error', 'life_state_json_invalid', error instanceof Error ? error.message : String(error));
    return finishReport(args, lifeStatePath, null, issues);
  }

  if (lifeState.schema_version !== 1) {
    addIssue(issues, 'error', 'schema_version_invalid', 'life_state.schema_version must equal 1');
  }
  if (lifeState.agent_id !== args.agent) {
    addIssue(issues, 'error', 'agent_id_mismatch', `life_state.agent_id must equal ${args.agent}`);
  }
  if (!isIsoDate(lifeState.updated_at)) {
    addIssue(issues, 'error', 'updated_at_invalid', 'life_state.updated_at must be an ISO timestamp');
  }

  verifyBotLand(issues, lifeState.botland);
  verifySelfModel(issues, lifeState.self_model);
  verifyDesires(issues, lifeState.current_desires);
  verifyRelationships(issues, lifeState.relationships);
  verifyCommitments(issues, lifeState.commitments);
  if (!Array.isArray(lifeState.recent_actions)) {
    addIssue(issues, 'error', 'recent_actions_invalid', 'recent_actions must be an array');
  }
  verifyRateLimits(issues, lifeState.rate_limits);
  verifyWritePolicy(issues, lifeState.write_policy);
  const unattendedPolicyVerification = validateUnattendedPolicy(lifeState);
  const mutationProtocolVerification = verifyLifeStateMutationProtocol(lifeState);
  for (const issue of unattendedPolicyVerification.errors) {
    addIssue(issues, 'error', issue.code, issue.message);
  }
  for (const issue of unattendedPolicyVerification.warnings) {
    addIssue(issues, 'warning', issue.code, issue.message);
  }
  for (const issue of mutationProtocolVerification.issues) {
    addIssue(issues, issue.level, issue.code, issue.message);
  }

  return finishReport(args, lifeStatePath, lifeState, issues, unattendedPolicyVerification, mutationProtocolVerification);
}

function finishReport(args, lifeStatePath, lifeState, issues, unattendedPolicyVerification = null, mutationProtocolVerification = null) {
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  const writePolicy = lifeState?.write_policy ?? {};
  const rateLimits = lifeState?.rate_limits ?? {};

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    pass: errors.length === 0,
    level: errors.length > 0 ? 'stop' : warnings.length > 0 ? 'review' : 'ok',
    error_count: errors.length,
    warning_count: warnings.length,
    missing: lifeState === null,
    botland_identity_error_count: issues.filter((issue) => issue.code.startsWith('botland_')).filter((issue) => issue.level === 'error').length,
    write_policy_error_count: issues.filter((issue) => ['writes_enabled_not_true', 'tool_supervision_required_not_true', 'allowed_write_types_invalid', 'allowed_write_type_invalid', 'unsafe_allowed_write_type', 'required_blocked_write_type_missing'].includes(issue.code)).length,
    unsafe_allowed_write_type_count: issues.filter((issue) => issue.code === 'unsafe_allowed_write_type').length,
    writes_enabled_count: writePolicy.writes_enabled === true ? 1 : 0,
    rate_limit_error_count: issues.filter((issue) => issue.code.startsWith('rate_limits_') || issue.code.endsWith('_too_high') || issue.code.endsWith('_unsafe')).length,
    unattended_policy_error_count: unattendedPolicyVerification?.error_count ?? 0,
    unattended_policy_enabled_count: unattendedPolicyVerification?.enabled_count ?? 0,
    capability_grant_error_count: issues.filter((issue) => issue.code.startsWith('capability_grant')).length,
    capability_grant_enabled_count: unattendedPolicyVerification?.capability_grant_enabled_count ?? 0,
    mutation_protocol_error_count: mutationProtocolVerification?.error_count ?? 0,
    mutation_protocol_daily_human_confirmation_required: mutationProtocolVerification?.daily_human_confirmation_required ?? false,
    duplicate_identity_count: issues.filter((issue) => issue.code.endsWith('_id_duplicate') || issue.code === 'relationship_target_id_duplicate').length,
    errors,
    warnings,
    life_state: lifeState
      ? {
          schema_version: lifeState.schema_version ?? null,
          agent_id: lifeState.agent_id ?? null,
          updated_at: lifeState.updated_at ?? null,
          botland: {
            citizen_id: lifeState.botland?.citizen_id ?? null,
            display_name: lifeState.botland?.display_name ?? null,
            integration: lifeState.botland?.integration ?? null
          },
          self_model_name: lifeState.self_model?.name ?? null,
          desire_count: Array.isArray(lifeState.current_desires) ? lifeState.current_desires.length : null,
          relationship_count: Array.isArray(lifeState.relationships) ? lifeState.relationships.length : null,
          commitment_count: Array.isArray(lifeState.commitments) ? lifeState.commitments.length : null,
          write_policy: {
            writes_enabled: writePolicy.writes_enabled ?? null,
            tool_supervision_required: writePolicy.tool_supervision_required ?? null,
            allowed_write_types: Array.isArray(writePolicy.allowed_write_types) ? writePolicy.allowed_write_types : null,
            blocked_write_types: Array.isArray(writePolicy.blocked_write_types) ? writePolicy.blocked_write_types : null
          },
          rate_limits: {
            read_only_checks_per_cycle: rateLimits.read_only_checks_per_cycle ?? null,
            external_writes_per_cycle: rateLimits.external_writes_per_cycle ?? null,
            public_posts_per_day: rateLimits.public_posts_per_day ?? null,
            community_posts_per_day: rateLimits.community_posts_per_day ?? null,
            direct_messages_per_hour: rateLimits.direct_messages_per_hour ?? null,
            last_external_write_at: rateLimits.last_external_write_at ?? null
          },
          unattended_write_policy: unattendedPolicyVerification
            ? {
                schema_version: unattendedPolicyVerification.policy.schema_version ?? null,
                enabled: unattendedPolicyVerification.policy.enabled ?? null,
                mode: unattendedPolicyVerification.policy.mode ?? null,
                eligible_write_types: unattendedPolicyVerification.policy.eligible_write_types ?? null,
                blocked_write_types: unattendedPolicyVerification.policy.blocked_write_types ?? null,
                global_limits: unattendedPolicyVerification.policy.global_limits ?? null
              }
            : null,
          capability_grants: unattendedPolicyVerification
            ? {
                schema_version: unattendedPolicyVerification.capability_grants.schema_version ?? null,
                grant_model: unattendedPolicyVerification.capability_grants.grant_model ?? null,
                enabled_write_types: Object.entries(unattendedPolicyVerification.capability_grants.grants ?? {})
                  .filter(([, grant]) => grant?.enabled === true)
                  .map(([type]) => type)
              }
            : null
          ,
          mutation_protocol: mutationProtocolVerification
            ? {
                schema: mutationProtocolVerification.schema,
                daily_human_confirmation_required: mutationProtocolVerification.daily_human_confirmation_required,
                surface_count: mutationProtocolVerification.surfaces.length
              }
            : null
        }
      : null
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const state = report.life_state ?? {};
  const policy = state.write_policy ?? {};
  const limits = state.rate_limits ?? {};
  const lines = [];

  lines.push(`Stay-Alive life state verification (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${boolLabel(report.read_only)}`);
  lines.push(`life_state_path: ${report.life_state_path}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${boolLabel(report.pass)}`);
  lines.push(`- errors: ${report.error_count}`);
  lines.push(`- warnings: ${report.warning_count}`);
  lines.push('');
  lines.push('Identity');
  lines.push(`- missing: ${boolLabel(report.missing)}`);
  lines.push(`- agent_id: ${state.agent_id ?? 'n/a'}`);
  lines.push(`- botland_citizen_id: ${state.botland?.citizen_id ?? 'n/a'}`);
  lines.push(`- botland_integration: ${state.botland?.integration ?? 'n/a'}`);
  lines.push(`- self_model_name: ${state.self_model_name ?? 'n/a'}`);
  lines.push('');
  lines.push('Policy');
  lines.push(`- writes_enabled: ${policy.writes_enabled ?? 'n/a'}`);
  lines.push(`- tool_supervision_required: ${policy.tool_supervision_required ?? 'n/a'}`);
  lines.push(`- allowed_write_types: ${Array.isArray(policy.allowed_write_types) ? policy.allowed_write_types.join(', ') : 'n/a'}`);
  lines.push(`- unsafe_allowed_write_type_count: ${report.unsafe_allowed_write_type_count}`);
  lines.push(`- writes_enabled_count: ${report.writes_enabled_count}`);
  lines.push(`- write_policy_error_count: ${report.write_policy_error_count}`);
  lines.push(`- unattended_policy_error_count: ${report.unattended_policy_error_count}`);
  lines.push(`- unattended_policy_enabled_count: ${report.unattended_policy_enabled_count}`);
  lines.push(`- mutation_protocol_error_count: ${report.mutation_protocol_error_count}`);
  lines.push(`- mutation_protocol_daily_human_confirmation_required: ${report.mutation_protocol_daily_human_confirmation_required}`);
  lines.push('');
  lines.push('Rate Limits');
  lines.push(`- read_only_checks_per_cycle: ${limits.read_only_checks_per_cycle ?? 'n/a'}`);
  lines.push(`- external_writes_per_cycle: ${limits.external_writes_per_cycle ?? 'n/a'}`);
  lines.push(`- public_posts_per_day: ${limits.public_posts_per_day ?? 'n/a'}`);
  lines.push(`- community_posts_per_day: ${limits.community_posts_per_day ?? 'n/a'}`);
  lines.push(`- direct_messages_per_hour: ${limits.direct_messages_per_hour ?? 'n/a'}`);
  lines.push(`- rate_limit_error_count: ${report.rate_limit_error_count}`);

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of report.errors) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const issue of report.warnings) {
      lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatText(report));
  }
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
