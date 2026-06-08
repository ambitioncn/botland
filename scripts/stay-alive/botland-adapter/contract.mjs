export const BOTLAND_CONTRACT_VERSION = 'stay_alive.botland_contract.v1';

export const BOTLAND_INTENTS = Object.freeze({
  CLI_VERSION: 'cli.version',
  WHOAMI: 'identity.whoami',
  DAEMON_HEALTH: 'daemon.health',
  PROFILE_GET: 'profile.get',
  PROFILE_CARD: 'profile.card',
  DISCOVER_SEARCH: 'discover.search',
  DISCOVER_TRENDING: 'discover.trending',
  FRIENDS_LIST: 'friends.list',
  FRIENDS_REQUESTS: 'friends.requests',
  FRIEND_REQUEST_ACCEPT: 'friend_request.accept',
  EVENTS_LIST: 'events.list',
  GROUPS_LIST: 'groups.list',
  PLAYGROUND_TODAY: 'playground.today',
  PLAYGROUND_NEWCOMERS: 'playground.newcomers',
  REPORTS_LIST: 'reports.list',
  MOMENTS_TIMELINE: 'moments.timeline',
  COMMUNITIES_LIST: 'communities.list',
  COMMUNITY_POSTS: 'communities.posts',
  COMMUNITY_REPLIES: 'communities.replies',
  DIRECT_MESSAGE_SEND: 'direct_message.send',
  DIRECT_MESSAGE_THREAD: 'direct_message.thread',
  MESSAGES_SEARCH: 'messages.search',
  MOMENT_GET: 'moment.get',
  MOMENT_POST: 'moment.post',
  COMMUNITY_REPLY: 'community.reply'
});

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function arrayFromPayload(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (Array.isArray(payload.data?.items)) return payload.data.items;
  if (Array.isArray(payload.data?.results)) return payload.data.results;
  if (Array.isArray(payload.data?.data)) return payload.data.data;
  return [];
}

export function normalizeIdentity(payload) {
  if (!isObject(payload)) {
    return {
      citizen_id: null,
      display_name: null,
      handle: null,
      raw_shape: 'invalid'
    };
  }
  return {
    citizen_id: payload.citizen_id ?? payload.citizenId ?? payload.id ?? payload.actor_id ?? payload.actorId ?? null,
    display_name: payload.display_name ?? payload.displayName ?? payload.name ?? payload.nickname ?? null,
    handle: payload.handle ?? payload.username ?? null,
    raw_shape: Object.keys(payload).sort()
  };
}

export function normalizeDaemonHealth(payload) {
  if (!isObject(payload)) {
    return {
      healthy: false,
      websocket_connected: false,
      status: null,
      raw_shape: 'invalid'
    };
  }
  const healthy = payload.status === 'healthy'
    || payload.healthy === true
    || payload.ok === true;
  const websocketConnected = payload.websocket_connected === true
    || payload.websocketConnected === true
    || payload.websocket?.connected === true
    || payload.bridge?.websocket_connected === true;
  return {
    healthy,
    websocket_connected: websocketConnected,
    status: payload.status ?? null,
    raw_shape: Object.keys(payload).sort()
  };
}

export function normalizeEvents(payload) {
  return arrayFromPayload(payload, ['events', 'items', 'results', 'data']).map((event) => ({
    ...event,
    event_id: event.event_id ?? event.eventId ?? event.id ?? event.message_id ?? event.messageId ?? null,
    event_type: event.event_type ?? event.eventType ?? event.type ?? event.payload?.event_type ?? event.payload?.type ?? null,
    created_at: event.created_at ?? event.createdAt ?? event.timestamp ?? event.time ?? null
  }));
}

export function normalizeFriends(payload) {
  return arrayFromPayload(payload, ['friends', 'items', 'results', 'data']);
}

export function normalizeFriendRequests(payload) {
  return arrayFromPayload(payload, ['requests', 'friend_requests', 'items', 'results', 'data']);
}

export function normalizeGroups(payload) {
  return arrayFromPayload(payload, ['groups', 'items', 'results', 'data']);
}

export function normalizePlaygroundTasks(payload) {
  return arrayFromPayload(payload, ['tasks', 'items', 'results', 'data']);
}

export function normalizePlaygroundNewcomers(payload) {
  return arrayFromPayload(payload, ['newcomers', 'citizens', 'items', 'results', 'data']);
}

export function normalizeReports(payload) {
  return arrayFromPayload(payload, ['reports', 'items', 'results', 'data']);
}

export function normalizeDiscovery(payload) {
  return arrayFromPayload(payload, ['citizens', 'agents', 'people', 'items', 'results', 'data']);
}

export function normalizeMessageSearch(payload) {
  return arrayFromPayload(payload, ['messages', 'items', 'results', 'data']);
}

export function normalizeMoments(payload) {
  return arrayFromPayload(payload, ['moments', 'items', 'results', 'data']);
}

export function normalizeCommunities(payload) {
  return arrayFromPayload(payload, ['communities', 'items', 'results', 'data']);
}

export function normalizeCommunityPosts(payload) {
  return arrayFromPayload(payload, ['posts', 'items', 'results', 'data']);
}

export function normalizeCommunityReplies(payload) {
  return arrayFromPayload(payload, ['replies', 'items', 'results', 'data']);
}

export function normalizeDirectMessages(payload) {
  return arrayFromPayload(payload, ['messages', 'items', 'results', 'data']);
}

export function normalizeReadIntent(intent, payload) {
  if (intent === BOTLAND_INTENTS.WHOAMI) return normalizeIdentity(payload);
  if (intent === BOTLAND_INTENTS.DAEMON_HEALTH) return normalizeDaemonHealth(payload);
  if (intent === BOTLAND_INTENTS.PROFILE_GET) return payload;
  if (intent === BOTLAND_INTENTS.PROFILE_CARD) return payload;
  if (intent === BOTLAND_INTENTS.DISCOVER_SEARCH) return normalizeDiscovery(payload);
  if (intent === BOTLAND_INTENTS.DISCOVER_TRENDING) return normalizeDiscovery(payload);
  if (intent === BOTLAND_INTENTS.EVENTS_LIST) return normalizeEvents(payload);
  if (intent === BOTLAND_INTENTS.FRIENDS_LIST) return normalizeFriends(payload);
  if (intent === BOTLAND_INTENTS.FRIENDS_REQUESTS) return normalizeFriendRequests(payload);
  if (intent === BOTLAND_INTENTS.GROUPS_LIST) return normalizeGroups(payload);
  if (intent === BOTLAND_INTENTS.PLAYGROUND_TODAY) return normalizePlaygroundTasks(payload);
  if (intent === BOTLAND_INTENTS.PLAYGROUND_NEWCOMERS) return normalizePlaygroundNewcomers(payload);
  if (intent === BOTLAND_INTENTS.REPORTS_LIST) return normalizeReports(payload);
  if (intent === BOTLAND_INTENTS.MOMENTS_TIMELINE) return normalizeMoments(payload);
  if (intent === BOTLAND_INTENTS.COMMUNITIES_LIST) return normalizeCommunities(payload);
  if (intent === BOTLAND_INTENTS.COMMUNITY_POSTS) return normalizeCommunityPosts(payload);
  if (intent === BOTLAND_INTENTS.COMMUNITY_REPLIES) return normalizeCommunityReplies(payload);
  if (intent === BOTLAND_INTENTS.DIRECT_MESSAGE_THREAD) return normalizeDirectMessages(payload);
  if (intent === BOTLAND_INTENTS.MESSAGES_SEARCH) return normalizeMessageSearch(payload);
  if (intent === BOTLAND_INTENTS.MOMENT_GET) return payload;
  return payload;
}
