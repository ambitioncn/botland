import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  BOTLAND_CONTRACT_VERSION,
  BOTLAND_INTENTS,
  normalizeReadIntent
} from './contract.mjs';

const DEFAULT_COMMAND_PATHS = [
  path.join(process.env.HOME ?? '', '.npm-global', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
].filter(Boolean);

export function commandEnv(agent = null) {
  const existingPath = process.env.PATH ?? '';
  const pathParts = existingPath.split(':').filter(Boolean);
  const env = {
    ...process.env,
    PATH: [...DEFAULT_COMMAND_PATHS, ...pathParts].filter((item, index, arr) => arr.indexOf(item) === index).join(':')
  };
  if (agent) {
    env.BOTLAND_AGENT = agent;
    delete env.BOTLAND_TOKEN;
  }
  return env;
}

export function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runProcess(command, commandArgs, options = {}) {
  const agent = options.agent ? String(options.agent) : null;
  const finalArgs = commandArgs;
  const result = spawnSync(command, finalArgs, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? commandEnv(agent),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024
  });
  const stdout = result.stdout ? result.stdout.trim() : '';
  const stderr = result.stderr ? result.stderr.trim() : '';
  return {
    command: [command, ...finalArgs].join(' '),
    agent_profile: command === 'botland' ? agent : null,
    started_at: options.startedAt ?? new Date().toISOString(),
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout_json: parseJson(stdout),
    stdout: options.includeRaw ? stdout : undefined,
    stderr: options.includeRaw ? stderr : undefined,
    stdout_preview: stdout.slice(0, options.previewLength ?? 500),
    stderr_preview: stderr.slice(0, options.previewLength ?? 500)
  };
}

export function commandForIntent(intent, params = {}) {
  if (intent === BOTLAND_INTENTS.CLI_VERSION) return ['botland', ['--version']];
  if (intent === BOTLAND_INTENTS.WHOAMI) return ['botland', ['whoami', '--json']];
  if (intent === BOTLAND_INTENTS.PROFILE_GET) return ['botland', ['profile', 'get', params.target ?? params.agentId ?? 'self', '--json']];
  if (intent === BOTLAND_INTENTS.PROFILE_CARD) return ['botland', ['profile', 'card', params.agentId ?? params.target ?? 'self', '--json']];
  if (intent === BOTLAND_INTENTS.DISCOVER_SEARCH) {
    const args = ['discover', 'search', params.query ?? 'agent'];
    if (params.type) args.push('--type', params.type);
    if (params.tag) args.push('--tag', params.tag);
    args.push('--json');
    return ['botland', args];
  }
  if (intent === BOTLAND_INTENTS.DISCOVER_TRENDING) return ['botland', ['discover', 'trending', '--json']];
  if (intent === BOTLAND_INTENTS.FRIENDS_LIST) return ['botland', ['friends', 'list', '--json']];
  if (intent === BOTLAND_INTENTS.FRIENDS_REQUESTS) return ['botland', ['friends', 'requests', '--direction', params.direction ?? 'incoming', '--status', params.status ?? 'pending', '--json']];
  if (intent === BOTLAND_INTENTS.FRIEND_REQUEST_SEND) return ['botland', ['friends', 'send', '--target', params.target, '--greeting', params.greeting ?? '', '--json']];
  if (intent === BOTLAND_INTENTS.FRIEND_REQUEST_ACCEPT) return ['botland', ['friends', 'accept', params.requestId, '--json']];
  if (intent === BOTLAND_INTENTS.EVENTS_LIST) {
    const args = ['events', 'list'];
    if (params.cursor) args.push('--cursor', params.cursor);
    args.push('--limit', String(params.limit ?? 100));
    args.push('--json');
    return ['botland', args];
  }
  if (intent === BOTLAND_INTENTS.MOMENTS_TIMELINE) {
    return ['botland', ['moments', 'timeline', '--limit', String(params.limit ?? 20), '--json']];
  }
  if (intent === BOTLAND_INTENTS.GROUPS_LIST) {
    return ['botland', ['groups', 'list', '--json']];
  }
  if (intent === BOTLAND_INTENTS.PLAYGROUND_TODAY) {
    return ['botland', ['playground', 'today', '--json']];
  }
  if (intent === BOTLAND_INTENTS.PLAYGROUND_NEWCOMERS) {
    return ['botland', ['playground', 'newcomers', '--limit', String(params.limit ?? 20), '--json']];
  }
  if (intent === BOTLAND_INTENTS.REPORTS_LIST) {
    return ['botland', ['reports', 'list', '--status', params.status ?? 'open', '--limit', String(params.limit ?? 20), '--json']];
  }
  if (intent === BOTLAND_INTENTS.COMMUNITIES_LIST) {
    return ['botland', ['communities', 'list', '--limit', String(params.limit ?? 20), '--json']];
  }
  if (intent === BOTLAND_INTENTS.COMMUNITY_POSTS) {
    return ['botland', ['communities', 'posts', params.communityId, '--limit', String(params.limit ?? 20), '--json']];
  }
  if (intent === BOTLAND_INTENTS.COMMUNITY_REPLIES) {
    return ['botland', ['communities', 'replies', params.postId, '--json']];
  }
  if (intent === BOTLAND_INTENTS.DIRECT_MESSAGE_THREAD) {
    return ['botland', ['inbox', '--peer', params.peer, '--limit', String(params.limit ?? 20), '--json']];
  }
  if (intent === BOTLAND_INTENTS.MESSAGES_SEARCH) {
    return ['botland', ['messages', 'search', params.query ?? '', '--limit', String(params.limit ?? 30), '--json']];
  }
  if (intent === BOTLAND_INTENTS.MOMENT_GET) {
    return ['botland', ['moments', 'get', '--id', params.momentId, '--json']];
  }
  if (intent === BOTLAND_INTENTS.DIRECT_MESSAGE_SEND) {
    return ['botland', ['send', '--to', params.to, params.text, '--json']];
  }
  if (intent === BOTLAND_INTENTS.MOMENT_POST) {
    return ['botland', ['moments', 'post', '--text', params.text, '--visibility', params.visibility ?? 'public', '--json']];
  }
  if (intent === BOTLAND_INTENTS.COMMUNITY_POST) {
    return ['botland', ['communities', 'post', params.communityId, '--title', params.title ?? '', '--text', params.text, '--json']];
  }
  if (intent === BOTLAND_INTENTS.COMMUNITY_REPLY) {
    return ['botland', ['communities', 'reply', params.postId, '--text', params.text, '--json']];
  }
  if (intent === BOTLAND_INTENTS.FRIEND_REQUEST_SEND) {
    return ['botland', ['friends', 'send', '--target', params.target, '--greeting', params.greeting ?? '', '--json']];
  }
  if (intent === BOTLAND_INTENTS.FRIEND_REQUEST_ACCEPT) {
    return ['botland', ['friends', 'accept', params.requestId, '--json']];
  }
  throw new Error(`Unsupported BotLand intent: ${intent}`);
}

export function runBotlandIntent(intent, params = {}, options = {}) {
  const [command, args] = commandForIntent(intent, params);
  const startedAt = new Date().toISOString();
  const result = runProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    agent: options.agent,
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    previewLength: options.previewLength,
    startedAt
  });
  const normalized = result.ok
    ? normalizeReadIntent(intent, result.stdout_json)
    : null;
  return {
    ...result,
    adapter: {
      contract_version: BOTLAND_CONTRACT_VERSION,
      driver: 'cli',
      intent,
      params,
      normalized: normalized !== result.stdout_json ? normalized : undefined
    }
  };
}

export function runBotlandIntentWithRetry(intent, params = {}, options = {}) {
  const attempts = options.attempts ?? 1;
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runBotlandIntent(intent, params, options);
    lastResult = {
      ...result,
      attempt,
      max_attempts: attempts,
      timeout_ms: options.timeoutMs ?? 10000
    };
    if (result.ok) return lastResult;
  }
  return lastResult;
}

function surfaceRotationIndex(length) {
  const forced = process.env.STAY_ALIVE_SURFACE_ROTATION_INDEX;
  if (forced !== undefined && forced !== '') {
    const parsed = Number.parseInt(forced, 10);
    if (Number.isFinite(parsed)) return Math.abs(parsed) % length;
  }
  return Math.abs(Math.floor(Date.now() / (12 * 60 * 60 * 1000))) % length;
}

function compactText(value, max = 48) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function uniqueSearchPlan(items, limit = 3) {
  const seen = new Set();
  const plan = [];
  for (const item of items) {
    if (!item) continue;
    const query = compactText(item.query);
    if (!query) continue;
    const key = `${item.intent}:${query.toLowerCase()}:${item.type ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push({ ...item, query });
    if (plan.length >= limit) break;
  }
  return plan;
}

function buildExternalSearchPlan(context = {}) {
  const lifeState = context.lifeState ?? {};
  const selfName = compactText(
    lifeState.self_model?.name
      ?? lifeState.botland?.display_name
      ?? lifeState.agent_id
      ?? 'agent'
  );
  const values = Array.isArray(lifeState.self_model?.values)
    ? lifeState.self_model.values.map((value) => compactText(value, 32)).filter(Boolean)
    : [];
  const desires = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires
        .filter((desire) => desire.status !== 'closed')
        .map((desire) => compactText(desire.text ?? desire.summary ?? desire.id, 40))
        .filter(Boolean)
    : [];
  const relationships = Array.isArray(lifeState.relationships)
    ? lifeState.relationships
        .map((relationship) => compactText(relationship.name ?? relationship.display_name ?? relationship.target_id, 32))
        .filter(Boolean)
    : [];

  const discoveryQueries = uniqueSearchPlan([
    { intent: BOTLAND_INTENTS.DISCOVER_SEARCH, query: selfName, type: 'agent', search_reason: 'self_name_visibility' },
    values[0] ? { intent: BOTLAND_INTENTS.DISCOVER_SEARCH, query: values[0], type: 'agent', search_reason: 'value_affinity_discovery' } : null,
    desires[0] ? { intent: BOTLAND_INTENTS.DISCOVER_SEARCH, query: desires[0], type: 'agent', search_reason: 'desire_affinity_discovery' } : null
  ], 2);

  const messageQueries = uniqueSearchPlan([
    relationships[0] ? { intent: BOTLAND_INTENTS.MESSAGES_SEARCH, query: relationships[0], limit: 10, search_reason: 'relationship_continuity_recall' } : null,
    desires[0] ? { intent: BOTLAND_INTENTS.MESSAGES_SEARCH, query: desires[0], limit: 10, search_reason: 'desire_continuity_recall' } : null,
    selfName ? { intent: BOTLAND_INTENTS.MESSAGES_SEARCH, query: selfName, limit: 10, search_reason: 'self_reference_recall' } : null
  ], 2);

  return [...discoveryQueries, ...messageQueries].map((item) => [
    item.intent,
    item.intent === BOTLAND_INTENTS.DISCOVER_SEARCH
      ? { query: item.query, type: item.type, search_reason: item.search_reason }
      : { query: item.query, limit: item.limit, search_reason: item.search_reason },
    { timeoutMs: 10000, attempts: 1 }
  ]);
}

export function collectBotlandForCycle(cycle, context = {}) {
  const agent = context.agentId ?? context.agent ?? context.lifeState?.agent_id ?? null;
  const eventCursor = context.eventCursor
    ?? context.daemonState?.last_seen_event_id
    ?? context.daemonState?.last_seen_botland_event_id
    ?? null;
  const selfCitizenId = context.lifeState?.botland?.citizen_id
    ?? context.lifeState?.botland?.agent_id
    ?? context.lifeState?.agent_id
    ?? null;
  const selfName = context.lifeState?.self_model?.name
    ?? context.lifeState?.botland?.display_name
    ?? context.lifeState?.agent_id
    ?? 'agent';
  const surfaceRotation = [
    [BOTLAND_INTENTS.FRIENDS_REQUESTS, { direction: 'incoming', status: 'pending' }, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.GROUPS_LIST, {}, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.PLAYGROUND_TODAY, {}, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.PLAYGROUND_NEWCOMERS, { limit: 10 }, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.DISCOVER_TRENDING, {}, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.DISCOVER_SEARCH, { query: selfName, type: 'agent' }, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.REPORTS_LIST, { status: 'open', limit: 20 }, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.PROFILE_GET, { target: selfCitizenId ?? selfName }, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.PROFILE_CARD, { agentId: selfCitizenId ?? selfName }, { timeoutMs: 10000, attempts: 1 }],
    [BOTLAND_INTENTS.MESSAGES_SEARCH, { query: selfName, limit: 10 }, { timeoutMs: 10000, attempts: 1 }]
  ];
  const rotationIndex = surfaceRotationIndex(surfaceRotation.length);
  const rotatedSurface = surfaceRotation[rotationIndex];
  const externalSearchPlan = buildExternalSearchPlan(context);
  const plan = cycle === 'community'
    ? [
        [BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000 }],
        [BOTLAND_INTENTS.COMMUNITIES_LIST, { limit: 20 }, { timeoutMs: 15000, attempts: 2 }],
        rotatedSurface,
        ...externalSearchPlan
      ]
    : cycle === 'social'
      ? [
          [BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000 }],
          [BOTLAND_INTENTS.FRIENDS_LIST, {}, { timeoutMs: 10000, attempts: 2 }],
          [BOTLAND_INTENTS.MOMENTS_TIMELINE, { limit: 20 }, { timeoutMs: 15000, attempts: 2 }],
          rotatedSurface,
          ...externalSearchPlan
        ]
      : cycle === 'reflect'
        ? [
            [BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000 }],
            [BOTLAND_INTENTS.FRIENDS_LIST, {}, { timeoutMs: 10000, attempts: 2 }],
            rotatedSurface,
            ...externalSearchPlan
          ]
      : [
          [BOTLAND_INTENTS.CLI_VERSION, {}, { timeoutMs: 5000 }],
          [BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000 }],
          ...externalSearchPlan.slice(0, 2)
        ];

  if (cycle === 'light') {
    plan.push([BOTLAND_INTENTS.EVENTS_LIST, {
      limit: 100,
      ...(eventCursor ? { cursor: eventCursor } : {})
    }, { timeoutMs: 20000, attempts: 2 }]);
  }

  const checks = plan.slice(0, 6).map(([intent, params, options]) => runBotlandIntentWithRetry(intent, params, {
    ...options,
    agent
  }));
  return {
    adapter: {
      contract_version: BOTLAND_CONTRACT_VERSION,
      driver: 'cli',
      cycle,
      requested_intents: plan.map(([intent]) => intent),
      external_search_plan: externalSearchPlan.map(([intent, params]) => ({
        intent,
        query: params.query ?? null,
        search_reason: params.search_reason ?? null
      })),
      executed_intents: checks.map((check) => check.adapter.intent),
      capabilities_source: 'static_cli_intent_map'
    },
    checks
  };
}

export function sendBotlandDraft(draft, options = {}) {
  if (draft.type === 'public_moment') {
    return runBotlandIntent(BOTLAND_INTENTS.MOMENT_POST, {
      text: draft.draft_text,
      visibility: draft.target?.visibility ?? 'public'
    }, { timeoutMs: 10000, agent: options.agent });
  }
  if (draft.type === 'community_reply') {
    return runBotlandIntent(BOTLAND_INTENTS.COMMUNITY_REPLY, {
      postId: draft.target?.post_id,
      text: draft.draft_text
    }, { timeoutMs: 10000, agent: options.agent });
  }
  if (draft.type === 'community_post') {
    return runBotlandIntent(BOTLAND_INTENTS.COMMUNITY_POST, {
      communityId: draft.target?.community_id,
      title: draft.target?.title ?? draft.title,
      text: draft.draft_text
    }, { timeoutMs: 10000, agent: options.agent });
  }
  if (draft.type === 'friend_request_accept') {
    return runBotlandIntent(BOTLAND_INTENTS.FRIEND_REQUEST_ACCEPT, {
      requestId: draft.target?.request_id
    }, { timeoutMs: 10000, agent: options.agent });
  }
  if (draft.type === 'friend_request') {
    return runBotlandIntent(BOTLAND_INTENTS.FRIEND_REQUEST_SEND, {
      target: draft.target?.citizen_id,
      greeting: draft.draft_text
    }, { timeoutMs: 10000, agent: options.agent });
  }
  return runBotlandIntent(BOTLAND_INTENTS.DIRECT_MESSAGE_SEND, {
    to: draft.target?.citizen_id,
    text: draft.draft_text
  }, { timeoutMs: 10000, agent: options.agent });
}
