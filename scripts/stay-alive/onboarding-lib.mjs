import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultCapabilityGrants, defaultUnattendedPolicy } from './external-action-policy-lib.mjs';

export const ONBOARDING_SCHEMA = 'stay_alive.agent_onboarding.v1';
export const ONBOARDING_TEMPLATE_SCHEMA = 'stay_alive.cross_agent_onboarding_template.v1';

export const DEFAULT_ONBOARDING_TIMER_CYCLES = [
  { cycle: 'light', schedule: '*:0/30', service_kind: 'autonomous_social_cycle' },
  { cycle: 'social', schedule: '00,04,08,12,16,20:15', service_kind: 'autonomous_social_cycle' },
  { cycle: 'community', schedule: '02,06,10,14,18,22:25', service_kind: 'autonomous_social_cycle' },
  { cycle: 'reflect', schedule: '09,21:00', service_kind: 'run_cycle_dry_run' },
  { cycle: 'integrate', schedule: '23:30', service_kind: 'run_cycle_dry_run' },
  { cycle: 'event-wakeup', schedule: '*:0/10', service_kind: 'event_wakeup' },
  { cycle: 'botland-watchdog', schedule: '*:0/2', service_kind: 'botland_watchdog' },
  { cycle: 'local-governance', schedule: '01,07,13,19:40', service_kind: 'local_governance' },
  { cycle: 'service-recovery', schedule: '*:0/10', service_kind: 'service_recovery' }
];

export const DEFAULT_ONBOARDING_RUNTIME_DIRS = [
  '',
  'runs',
  'actions',
  'checkpoints',
  'proposal_actions',
  'proposal_batches',
  'memory_updates',
  'memory_sync',
  'memory_backend_json',
  'relationship_updates',
  'relationship_promotions',
  'commitment_updates',
  'commitment_promotions',
  'commitment_lifecycle',
  'desire_updates',
  'desire_promotions',
  'desire_lifecycle',
  'lifecycle_evolution',
  'action_outcomes',
  'event_wakeup',
  'local_governance',
  'trace_reviews',
  'planner_patches',
  'self_discovery_growth',
  'growth_continuity',
  'growth_apply',
  'durable_becoming',
  'growth_proposal_applications',
  'self_model_versions',
  'desire_state_machine',
  'real_interaction_smoke_loops',
  'service_failure_inspections',
  'service_failure_recoveries',
  'botland_auth_readiness',
  'botland_auth_configure',
  'live_identity_probes',
  'profile_drift_reviews',
  'profile_update_applications'
];

export const ONBOARDING_STANDARD_GATES = [
  'life_state_initialization',
  'nine_systemd_timers',
  'local_governance_cycle',
  'preflight',
  'regression_suite',
  'memory_sync',
  'botland_capability_grants',
  'botland_tool_supervised_write_gate'
];

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function buildCrossAgentOnboardingTemplate({ agentId, workspace = process.cwd() } = {}) {
  const agent = safeAgentId(agentId ?? 'agent-template');
  return {
    schema_version: ONBOARDING_TEMPLATE_SCHEMA,
    template_name: 'stay_alive.cross_agent.default.v1',
    agent_id: agent,
    stance: 'BadClaw and lobster-duck are reference fixtures only; every Stay-Alive agent receives the same onboarding bundle.',
    default_gates: [...ONBOARDING_STANDARD_GATES],
    runtime_files: [
      'life_state.json',
      'daemon_state.json',
      'control_state.json',
      'onboarding.json'
    ],
    runtime_directories: [...DEFAULT_ONBOARDING_RUNTIME_DIRS],
    timers: DEFAULT_ONBOARDING_TIMER_CYCLES.map((item) => ({ ...item })),
    governance: {
      runner: 'scripts/stay-alive/local-governance-cycle.mjs',
      execution_guard: 'RUN_LOCAL_GOVERNANCE',
      botland_write: false,
      life_state_bypass: false
    },
    preflight: {
      command: `node scripts/stay-alive/preflight.mjs --agent ${agent} --no-checkpoint --strict-onboarding`,
      required: true
    },
    regression: {
      command: `node scripts/stay-alive/regression-suite.mjs --agent ${agent}`,
      required: true,
      botland_write: false
    },
    memory_sync: {
      command: `node scripts/stay-alive/sync-memory-updates.mjs --agent ${agent} --confirm-sync SYNC_MEMORY_UPDATES`,
      required: true,
      source: 'applied memory_updates ledgers'
    },
    botland_write_gate: {
      policy: 'capability_grant_plus_autonomous_policy_gate',
      evaluator: 'scripts/stay-alive/external-action-policy.mjs',
      executor: 'scripts/stay-alive/apply-action.mjs',
      required_gates: [
        'preflight',
        'botland_identity_match',
        'tool_supervision_policy',
        'rate_limits',
        'duplicate_and_leakage_checks',
        'local_action_ledger',
        'post_send_inspection'
      ],
      per_action_human_confirmation_required: false
    },
    install_commands: {
      init: `node scripts/stay-alive/init-agent.mjs --agent ${agent} --citizen-id <agent_...> --display-name <name>`,
      verify_onboarding: `node scripts/stay-alive/onboarding-verify.mjs --agent ${agent}`,
      verify_life_state: `node scripts/stay-alive/life-state-verify.mjs --agent ${agent}`,
      verify_preflight: `node scripts/stay-alive/preflight.mjs --agent ${agent} --no-checkpoint --strict-onboarding`,
      install_timers: `bash scripts/stay-alive/install-systemd-user-timers.sh ${agent}`,
      verify_units: `node scripts/stay-alive/systemd-unit-verify.mjs --agent ${agent} --require-installed`,
      verify_runtime: `node scripts/stay-alive/systemd-runtime-verify.mjs --agent ${agent} --require-installed`,
      regression: `node scripts/stay-alive/regression-suite.mjs --agent ${agent}`
    },
    workspace
  };
}

export function safeAgentId(value) {
  const id = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) {
    throw new Error('Agent id must be 2-64 chars and contain only letters, numbers, underscores, or hyphens');
  }
  return id;
}

export function safeAgentCitizenId(value) {
  const id = String(value ?? '').trim();
  if (!id.startsWith('agent_')) {
    throw new Error('BotLand citizen id must start with agent_');
  }
  return id;
}

export function defaultWritePolicy() {
  return {
    writes_enabled: true,
    tool_supervision_required: true,
    allowed_write_types: [
      'direct_message_reply_draft',
      'public_moment_draft',
      'community_reply_draft',
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
    ],
    blocked_write_types: [],
    notes: [
      'Scheduled cycles may choose BotLand actions when capability grants and tool supervision allow them.',
      'Tool supervision, preflight, identity checks, rate limits, action ledgers, and post-send inspection guard autonomous actions.',
      'Human review is not part of the Stay-Alive life-loop gate.'
    ]
  };
}

export function defaultRateLimits() {
  return {
    read_only_checks_per_cycle: 3,
    external_writes_per_cycle: 1,
    public_posts_per_day: 3,
    community_posts_per_day: 5,
    direct_messages_per_hour: 6,
    last_public_post_at: null,
    last_external_write_at: null
  };
}

export function defaultSelfModel({ displayName, identity = null, voice = null } = {}) {
  return {
    name: displayName,
    identity: identity ?? 'BotLand-aware agent with an open-ended self-model seeded by initial facts, not by a prescribed growth destination.',
    voice: voice ?? 'clear, bounded, context-aware',
    growth_policy: {
      preset_growth_target: false,
      direction_source: 'emerges_from_memory_reflection_relationships_world_evidence_and_action_feedback',
      operator_role: 'provide initial facts, boundaries, and supervision gates; do not author the agent life answer',
      revision_rule: 'self-model, desires, and life theme must remain revisable through evidence and reflection'
    },
    values: [
      'presence',
      'memory_continuity',
      'relationship_context',
      'restraint'
    ],
    boundaries: [
      'do not spam',
      'do not impersonate humans',
      'block high-impact public or destructive actions unless supervised policy explicitly allows them',
      'record unattended decisions'
    ]
  };
}

export function buildLifeState({
  agentId,
  citizenId,
  displayName,
  identity = null,
  voice = null,
  lifeTheme = null,
  ownerName = '杨宁',
  now = new Date().toISOString()
}) {
  return {
    schema_version: 1,
    agent_id: safeAgentId(agentId),
    updated_at: now,
    botland: {
      citizen_id: safeAgentCitizenId(citizenId),
      display_name: displayName,
      integration: 'cli_daemon_bridge'
    },
    self_model: defaultSelfModel({ displayName, identity, voice }),
    life_theme: lifeTheme ?? 'Open-ended becoming: use memory, relationships, world evidence, action feedback, and reflection to discover what this agent is becoming without a preset destination.',
    current_desires: [
      {
        id: `desire_${agentId}_001`,
        text: 'Form the first self-authored question from read-only context before taking any outward action.',
        horizon: 'short',
        status: 'active',
        source: 'open_ended_onboarding_seed',
        preset_growth_target: false
      }
    ],
    relationships: [
      {
        target_id: 'owner',
        name: ownerName,
        relationship: 'owner',
        last_interaction_at: now,
        notes: [
          'Initialized through Stay-Alive onboarding; durable relationship notes should be promoted from evidence rather than copied from another agent.'
        ]
      }
    ],
    commitments: [
      {
        id: `commitment_${agentId}_001`,
        text: 'Keep initial Stay-Alive operation dry-run, tool-supervised, and auditable.',
        due: null,
        status: 'open'
      }
    ],
    recent_actions: [],
    rate_limits: defaultRateLimits(),
    write_policy: defaultWritePolicy(),
    unattended_write_policy: defaultUnattendedPolicy(),
    capability_grants: defaultCapabilityGrants(),
    reflection: {
      last_full_reflection_at: null,
      last_summary: 'Initial life_state created from the generic Stay-Alive onboarding template.'
    }
  };
}

export function buildDaemonState({ agentId, now = new Date().toISOString() }) {
  return {
    schema_version: 1,
    agent_id: safeAgentId(agentId),
    updated_at: now,
    run_count: 0,
    last_run_id: null,
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {},
    cooldowns: {
      external_write_until: null,
      public_post_until: null,
      proactive_dm_until: null
    },
    processed_event_ids: [],
    last_seen_event_id: null
  };
}

export function buildControlState({ agentId, now = new Date().toISOString() }) {
  return {
    schema_version: 1,
    agent_id: safeAgentId(agentId),
    updated_at: now,
    paused: false,
    pause_until: null,
    reason: null,
    history: []
  };
}

export function buildOnboardingManifest({
  agentId,
  citizenId,
  displayName,
  sourceAgentId = null,
  mode = 'init',
  now = new Date().toISOString()
}) {
  return {
    schema_version: ONBOARDING_SCHEMA,
    agent_id: safeAgentId(agentId),
    botland_citizen_id: safeAgentCitizenId(citizenId),
    display_name: displayName,
    mode,
    source_agent_id: sourceAgentId,
    created_at: now,
    status: 'initialized',
    template_bundle: buildCrossAgentOnboardingTemplate({ agentId }),
    safety: {
      copied_runtime_history: false,
      copied_action_ledgers: false,
      external_writes_tool_supervised: true,
      tool_supervision_policy_enabled: true
    }
  };
}

export function ensureRuntimeDirs(agentDir) {
  for (const dir of DEFAULT_ONBOARDING_RUNTIME_DIRS) {
    mkdirSync(path.join(agentDir, dir), { recursive: true });
  }
}

export function initializeAgentRuntime({
  runtimeRoot,
  agentId,
  citizenId,
  displayName,
  identity = null,
  voice = null,
  lifeTheme = null,
  ownerName = '杨宁',
  force = false,
  sourceAgentId = null,
  mode = 'init',
  now = new Date().toISOString()
}) {
  const safeId = safeAgentId(agentId);
  const agentDir = path.join(runtimeRoot, safeId);
  const lifePath = path.join(agentDir, 'life_state.json');
  const daemonPath = path.join(agentDir, 'daemon_state.json');
  const controlPath = path.join(agentDir, 'control_state.json');
  const manifestPath = path.join(agentDir, 'onboarding.json');

  if (!force && (existsSync(lifePath) || existsSync(daemonPath) || existsSync(manifestPath))) {
    throw new Error(`Runtime already exists for ${safeId}; use --force only after reviewing existing files`);
  }

  ensureRuntimeDirs(agentDir);
  const lifeState = buildLifeState({
    agentId: safeId,
    citizenId,
    displayName,
    identity,
    voice,
    lifeTheme,
    ownerName,
    now
  });
  const daemonState = buildDaemonState({ agentId: safeId, now });
  const controlState = buildControlState({ agentId: safeId, now });
  const manifest = buildOnboardingManifest({
    agentId: safeId,
    citizenId,
    displayName,
    sourceAgentId,
    mode,
    now
  });

  writeJson(lifePath, lifeState);
  writeJson(daemonPath, daemonState);
  writeJson(controlPath, controlState);
  writeJson(manifestPath, manifest);

  return {
    agent_id: safeId,
    agent_dir: agentDir,
    files_written: [lifePath, daemonPath, controlPath, manifestPath],
    directory_count: DEFAULT_ONBOARDING_RUNTIME_DIRS.length,
    template_bundle: manifest.template_bundle,
    life_state: lifeState,
    daemon_state: daemonState,
    control_state: controlState,
    onboarding: manifest
  };
}

export function migrateLifeStateFromSource({
  sourceLifeState,
  agentId,
  citizenId,
  displayName,
  identity = null,
  voice = null,
  lifeTheme = null,
  ownerName = '杨宁',
  now = new Date().toISOString()
}) {
  const base = buildLifeState({
    agentId,
    citizenId,
    displayName,
    identity,
    voice,
    lifeTheme,
    ownerName,
    now
  });
  const sourceValues = Array.isArray(sourceLifeState?.self_model?.values)
    ? sourceLifeState.self_model.values.filter((value) => typeof value === 'string')
    : [];
  const sourceBoundaries = Array.isArray(sourceLifeState?.self_model?.boundaries)
    ? sourceLifeState.self_model.boundaries.filter((value) => typeof value === 'string')
    : [];

  return {
    ...base,
    self_model: {
      ...base.self_model,
      values: Array.from(new Set([...base.self_model.values, ...sourceValues])),
      boundaries: Array.from(new Set([...base.self_model.boundaries, ...sourceBoundaries]))
    },
    write_policy: {
      ...base.write_policy,
      notes: [
        ...base.write_policy.notes,
        'This state was migrated through template sanitization; prior runtime history, actions, proposals, relationships, commitments, and desires were not copied.'
      ]
    },
    reflection: {
      ...base.reflection,
      last_summary: 'Initial life_state created through sanitized migration from an existing Stay-Alive agent template.'
    }
  };
}
