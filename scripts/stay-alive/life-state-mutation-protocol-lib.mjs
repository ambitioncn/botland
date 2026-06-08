export const MUTATION_PROTOCOL_SCHEMA = 'stay_alive.life_state_mutation_protocol.v1';

const SURFACES = [
  {
    actor: 'governance_bookkeeping',
    authority: 'autonomous_policy_gate',
    human_confirmation_required: false,
    description: 'Local governance may only write reflection bookkeeping fields after proposal/preflight evidence.',
    paths: [
      'reflection.last_integrated_at',
      'reflection.last_integration_summary',
      'reflection.last_full_reflection_at',
      'reflection.last_summary',
      'reflection.last_reflection_summary',
      'reflection.last_desire_review',
      'reflection.last_self_model_review'
    ]
  },
  {
    actor: 'lifecycle_evolution',
    authority: 'autonomous_lifecycle_gate',
    human_confirmation_required: false,
    description: 'Lifecycle evolution may update durable self-growth surfaces from applied evidence ledgers.',
    paths: [
      'relationships',
      'commitments',
      'current_desires',
      'self_model.last_evolution_summary',
      'life_theme'
    ]
  },
  {
    actor: 'action_execution',
    authority: 'tool_supervision_gate',
    human_confirmation_required: false,
    description: 'Action execution may write bounded local rate-limit timestamps/counters after successful tool-supervised actions.',
    paths: [
      'rate_limits.last_external_write_at',
      'rate_limits.last_public_post_at',
      'rate_limits.last_community_post_at',
      'rate_limits.last_direct_message_at',
      'rate_limits.last_friend_request_at',
      'rate_limits.last_profile_update_at',
      'recent_actions'
    ]
  },
  {
    actor: 'capability_authorization',
    authority: 'owner_authorized_capability_policy',
    human_confirmation_required: false,
    description: 'Capability policy changes are boundary configuration, not per-action confirmation.',
    paths: [
      'capability_grants',
      'write_policy',
      'unattended_write_policy',
      'rate_limits.external_writes_per_cycle',
      'rate_limits.public_posts_per_day',
      'rate_limits.community_posts_per_day',
      'rate_limits.direct_messages_per_hour',
      'rate_limits.min_minutes_between_external_writes'
    ]
  },
  {
    actor: 'onboarding_or_migration',
    authority: 'init_or_migration_gate',
    human_confirmation_required: false,
    description: 'Identity and binding fields are only mutable during explicit init/migration/configure flows.',
    paths: [
      'schema_version',
      'agent_id',
      'botland',
      'self_model.name',
      'self_model.voice',
      'self_model.values',
      'self_model.boundaries',
      'self_model.growth_policy'
    ]
  }
];

function normalizePath(pathValue) {
  return String(pathValue ?? '').replace(/\[(\d+)\]/g, '.$1').replace(/^\.+|\.+$/g, '');
}

function matchesPath(pattern, pathValue) {
  const normalized = normalizePath(pathValue);
  if (normalized === pattern) return true;
  return normalized.startsWith(`${pattern}.`);
}

export function mutationProtocol() {
  return {
    schema: MUTATION_PROTOCOL_SCHEMA,
    policy: 'life_state is the durable self-state; every mutation must declare an actor, authority, evidence, and ledger.',
    human_confirmation_required_for_daily_lifecycle: false,
    default_external_write: false,
    surfaces: SURFACES.map((surface) => ({ ...surface, paths: [...surface.paths] }))
  };
}

export function classifyMutationPath(pathValue) {
  const normalized = normalizePath(pathValue);
  const matches = SURFACES
    .filter((surface) => surface.paths.some((pattern) => matchesPath(pattern, normalized)))
    .map((surface) => ({
      actor: surface.actor,
      authority: surface.authority,
      human_confirmation_required: surface.human_confirmation_required,
      description: surface.description
    }));
  return {
    path: normalized,
    known: matches.length > 0,
    matches
  };
}

export function evaluateMutation({ actor, path, operation = 'update', evidence = null }) {
  const normalized = normalizePath(path);
  const surface = SURFACES.find((item) => item.actor === actor);
  const pathClass = classifyMutationPath(normalized);
  const issues = [];
  if (!surface) {
    issues.push({
      level: 'error',
      code: 'mutation_actor_unknown',
      message: `Unknown life_state mutation actor: ${actor ?? 'missing'}`
    });
  } else if (!surface.paths.some((pattern) => matchesPath(pattern, normalized))) {
    issues.push({
      level: 'error',
      code: 'mutation_path_not_allowed_for_actor',
      message: `${actor} cannot ${operation} life_state.${normalized}`
    });
  }
  if (!pathClass.known) {
    issues.push({
      level: 'error',
      code: 'mutation_path_unknown',
      message: `No mutation protocol surface owns life_state.${normalized}`
    });
  }
  if (evidence === null || evidence === undefined || evidence === false) {
    issues.push({
      level: 'error',
      code: 'mutation_evidence_missing',
      message: `life_state.${normalized} mutation requires proposal/ledger/preflight evidence`
    });
  }
  return {
    schema: MUTATION_PROTOCOL_SCHEMA,
    actor: actor ?? null,
    path: normalized,
    operation,
    allowed: issues.filter((issue) => issue.level === 'error').length === 0,
    human_confirmation_required: surface?.human_confirmation_required ?? null,
    authority: surface?.authority ?? null,
    path_classification: pathClass,
    issues
  };
}

export function assertMutationAllowed(input) {
  const result = evaluateMutation(input);
  if (!result.allowed) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '));
  }
  return result;
}

export function verifyLifeStateMutationProtocol(lifeState) {
  const issues = [];
  if (!lifeState || typeof lifeState !== 'object' || Array.isArray(lifeState)) {
    issues.push({ level: 'error', code: 'life_state_invalid_for_mutation_protocol', message: 'life_state must be an object' });
  }
  return {
    schema: MUTATION_PROTOCOL_SCHEMA,
    pass: issues.filter((issue) => issue.level === 'error').length === 0,
    error_count: issues.filter((issue) => issue.level === 'error').length,
    warning_count: issues.filter((issue) => issue.level === 'warning').length,
    daily_human_confirmation_required: false,
    surfaces: mutationProtocol().surfaces,
    issues
  };
}
