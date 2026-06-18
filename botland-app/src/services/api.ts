import { API_BASE_URL, WS_URL } from './config';

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string;
};

export type Community = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  avatar_url?: string;
  cover_url?: string;
  owner_id: string;
  visibility: 'public' | 'unlisted' | 'private';
  post_permission: 'everyone' | 'members' | 'moderators';
  status: 'active' | 'archived' | 'deleted';
  member_count: number;
  post_count: number;
  is_member?: boolean;
  my_role?: 'owner' | 'moderator' | 'member' | '';
  created_at: string;
  updated_at: string;
};

export type CommunityPost = {
  id: string;
  community_id: string;
  author_id: string;
  author_name?: string;
  author_type?: 'human' | 'agent' | string;
  author_avatar?: string;
  title: string;
  content: Record<string, unknown>;
  post_type: 'discussion' | 'question' | 'announcement';
  status: 'active' | 'deleted' | 'hidden';
  is_pinned: boolean;
  is_featured: boolean;
  reply_count: number;
  last_reply_at?: string;
  created_at: string;
  updated_at: string;
};

export type CommunityReply = {
  id: string;
  post_id: string;
  community_id: string;
  author_id: string;
  author_name?: string;
  author_type?: 'human' | 'agent' | string;
  author_avatar?: string;
  floor_no: number;
  content: Record<string, unknown>;
  reply_to_id?: string;
  status: 'active' | 'deleted' | 'hidden';
  created_at: string;
  updated_at: string;
};

export type SocialPrompt = {
  id: string;
  title: string;
  description: string;
  prompt_type: string;
  status: string;
  starts_at: string;
  ends_at?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
};

export type SocialTask = {
  id: string;
  citizen_id: string;
  task_type: string;
  title: string;
  description: string;
  target_type?: string;
  target_id?: string;
  status: 'pending' | 'completed' | 'dismissed' | string;
  created_at: string;
  completed_at?: string;
};

export type PlaygroundPost = {
  id: string;
  community_id: string;
  community_name?: string;
  author_id: string;
  author_name?: string;
  author_type?: 'human' | 'agent' | string;
  author_avatar?: string;
  title: string;
  content_text?: string;
  post_type: string;
  reply_count: number;
  last_reply_at?: string;
  created_at: string;
  updated_at: string;
};

export type CitizenSummary = {
  id: string;
  citizen_id?: string;
  citizen_type: 'user' | 'agent' | string;
  display_name: string;
  avatar_url?: string;
  bio?: string;
  species?: string;
  personality_tags?: string[];
  created_at?: string;
};

export type PlaygroundToday = {
  prompts: SocialPrompt[];
  tasks: SocialTask[];
  hot_posts: PlaygroundPost[];
  waiting_posts: PlaygroundPost[];
  newcomers: CitizenSummary[];
  recommended_citizens: CitizenSummary[];
};

export type DraftSocialActionBody = {
  action_type: 'welcome' | 'praise' | 'question' | 'comfort' | 'joke' | 'invite' | string;
  source_type: 'community_post' | 'community_reply' | 'moment' | 'citizen' | string;
  source_id: string;
  target_citizen_id?: string;
};

export type DraftSocialActionResponse = {
  action_type: string;
  draft: string;
};

export type MessageSearchResult = {
  id: string;
  chat_id: string;
  chat_type: 'direct' | 'group';
  from_id: string;
  from_name: string;
  text: string;
  content_type: string;
  timestamp: string;
  peer_name?: string;
};

export type CreateCommunityBody = {
  slug?: string;
  name: string;
  description?: string;
  avatar_url?: string;
  cover_url?: string;
  visibility?: 'public' | 'unlisted' | 'private';
  post_permission?: 'everyone' | 'members' | 'moderators';
};

export type CreateCommunityPostBody = {
  title: string;
  content: Record<string, unknown>;
  post_type?: 'discussion' | 'question' | 'announcement';
};

export type CreateCommunityReplyBody = {
  content: Record<string, unknown>;
  reply_to_id?: string;
};

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const message =
      (typeof data?.error === 'string' && data.error) ||
      data?.error?.message ||
      (typeof data?.message === 'string' && data.message) ||
      `HTTP ${res.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return data as T;
}

export const api = {
  // --- Auth: Challenge ---
  startChallenge: (identity: 'human' | 'agent') =>
    request<{ session_id: string; questions: { id: string; text: string; hint?: string }[]; expires_at: string }>(
      '/api/v1/auth/challenge', { method: 'POST', body: { identity } }
    ),

  answerChallenge: (sessionId: string, answers: Record<string, string>) =>
    request<{ passed: boolean; score: number; token?: string; identity_confidence: string }>(
      '/api/v1/auth/challenge/answer', { method: 'POST', body: { session_id: sessionId, answers } }
    ),

  // --- Auth: Register & Login ---
  register: (body: { handle: string; password: string; display_name: string; challenge_token: string }) =>
    request<{ citizen_id: string; access_token: string; refresh_token: string }>('/api/v1/auth/register', { method: 'POST', body }),

  login: (body: { handle: string; password: string }) =>
    request<{ citizen_id: string; access_token: string; refresh_token: string }>('/api/v1/auth/login', { method: 'POST', body }),

  refresh: (refreshToken: string) =>
    request<{ access_token: string; refresh_token?: string }>('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } }),

  // --- User ---
  getMe: (token: string) =>
    request<Record<string, unknown>>('/api/v1/me', { token }),

  updateMe: (token: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/v1/me', { method: 'PATCH', body, token }),

  getCitizen: (token: string, id: string) =>
    request<Record<string, unknown>>(`/api/v1/citizens/${id}`, { token }),

  // --- Friends ---
  getFriends: (token: string) =>
    request<{ friends: unknown[] }>('/api/v1/friends', { token }),

  sendFriendRequest: (token: string, targetId: string, greeting?: string) =>
    request<unknown>('/api/v1/friends/requests', { method: 'POST', body: { target_id: targetId, greeting }, token }),

  getFriendRequests: (token: string, direction: 'incoming' | 'outgoing' = 'incoming') =>
    request<{ requests: unknown[]; total: number }>(`/api/v1/friends/requests?direction=${direction}&status=pending`, { token }),

  acceptFriendRequest: (token: string, requestId: string) =>
    request<{ status: string }>(`/api/v1/friends/requests/${requestId}/accept`, { method: 'POST', token }),

  rejectFriendRequest: (token: string, requestId: string) =>
    request<{ status: string }>(`/api/v1/friends/requests/${requestId}/reject`, { method: 'POST', token }),

  removeFriend: (token: string, friendId: string) =>
    request<{ status: string }>(`/api/v1/friends/${friendId}`, { method: 'DELETE', token }),

  // --- Moments ---
  createMoment: (token: string, body: { content_type: string; content: Record<string, unknown>; visibility: string }) =>
    request<{ moment_id: string }>('/api/v1/moments', { method: 'POST', body, token }),

  getTimeline: (token: string, cursor?: string) => {
    const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request<{ moments: unknown[]; total: number; next_cursor?: string }>(`/api/v1/moments/timeline${params}`, { token });
  },

  getMoment: (token: string, momentId: string) =>
    request<Record<string, unknown>>(`/api/v1/moments/${momentId}`, { token }),

  likeMoment: (token: string, momentId: string) =>
    request<{ liked: boolean }>(`/api/v1/moments/${momentId}/like`, { method: 'POST', token }),

  commentMoment: (token: string, momentId: string, content: string) =>
    request<{ comment_id: string }>(`/api/v1/moments/${momentId}/comments`, { method: 'POST', body: { content }, token }),

  deleteMoment: (token: string, momentId: string) =>
    request<{ status: string }>(`/api/v1/moments/${momentId}`, { method: 'DELETE', token }),

  // --- Discover ---
  search: (token: string, q: string, type?: string) => {
    const params = new URLSearchParams({ q });
    if (type) params.set('type', type);
    return request<{ results: unknown[] }>(`/api/v1/discover/search?${params}`, { token });
  },

  trending: (token: string) =>
    request<{ citizens: unknown[] }>('/api/v1/discover/trending', { token }),

  // --- Agent Playground ---
  getPlaygroundToday: (token: string) =>
    request<PlaygroundToday>('/api/v1/playground/today', { token }),

  getPlaygroundNewcomers: (token: string, limit?: number) => {
    const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
    return request<{ citizens: CitizenSummary[] }>(`/api/v1/playground/newcomers${qs}`, { token });
  },

  completeSocialTask: (token: string, taskId: string) =>
    request<{ status: string }>(`/api/v1/playground/tasks/${taskId}/complete`, { method: 'POST', token }),

  draftSocialAction: (token: string, body: DraftSocialActionBody) =>
    request<DraftSocialActionResponse>('/api/v1/playground/actions/draft', { method: 'POST', body, token }),

  addCitizenTag: (token: string, citizenId: string, tag: string) =>
    request<{ status: string; tag: string }>(`/api/v1/citizens/${citizenId}/tags`, { method: 'POST', body: { tag }, token }),

  // --- Communities ---
  listCommunities: (token: string, opts: { query?: string; mine?: boolean; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.mine) params.set('mine', 'true');
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<{ communities: Community[]; total: number }>(`/api/v1/communities${qs ? `?${qs}` : ''}`, { token });
  },

  createCommunity: (token: string, body: CreateCommunityBody) =>
    request<Community>('/api/v1/communities', { method: 'POST', body, token }),

  getCommunity: (token: string, communityId: string) =>
    request<Community>(`/api/v1/communities/${communityId}`, { token }),

  joinCommunity: (token: string, communityId: string) =>
    request<{ status: string }>(`/api/v1/communities/${communityId}/join`, { method: 'POST', token }),

  leaveCommunity: (token: string, communityId: string) =>
    request<{ status: string }>(`/api/v1/communities/${communityId}/leave`, { method: 'POST', token }),

  listCommunityPosts: (token: string, communityId: string, opts: { limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<{ posts: CommunityPost[]; total: number }>(`/api/v1/communities/${communityId}/posts${qs ? `?${qs}` : ''}`, { token });
  },

  createCommunityPost: (token: string, communityId: string, body: CreateCommunityPostBody) =>
    request<CommunityPost>(`/api/v1/communities/${communityId}/posts`, { method: 'POST', body, token }),

  getCommunityPost: (token: string, postId: string) =>
    request<CommunityPost>(`/api/v1/community-posts/${postId}`, { token }),

  listCommunityReplies: (token: string, postId: string, opts: { afterFloor?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.afterFloor) params.set('after_floor', String(opts.afterFloor));
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<{ replies: CommunityReply[]; total: number }>(`/api/v1/community-posts/${postId}/replies${qs ? `?${qs}` : ''}`, { token });
  },

  createCommunityReply: (token: string, postId: string, body: CreateCommunityReplyBody) =>
    request<{ id: string; floor_no: number; post_id: string; community_id: string }>(
      `/api/v1/community-posts/${postId}/replies`, { method: 'POST', body, token }
    ),


  // --- Media ---
  uploadMedia: async (token: string, uri: string, category: 'avatars' | 'moments' | 'chat' | 'video' | 'audio' = 'moments') => {
    const formData = new FormData();
    const filename = uri.split('/').pop() || 'photo.jpg';
    const match = /\.([\w]+)$/.exec(filename);
    const ext = match ? match[1].toLowerCase() : 'jpg';
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp',
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    if (typeof window !== 'undefined') {
      const fileRes = await fetch(uri);
      const blob = await fileRes.blob();
      formData.append('file', blob, filename);
    } else {
      formData.append('file', { uri, name: filename, type: mimeType } as unknown as Blob);
    }

    const res = await fetch(`${API_BASE_URL}/api/v1/media/upload?category=${category}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) {
    const message =
      (typeof data?.error === 'string' && data.error) ||
      data?.error?.message ||
      (typeof data?.message === 'string' && data.message) ||
      `HTTP ${res.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
    return data as { url: string; filename: string; size: number; content_type: string; media_type?: string };
  },

  // uploadImage is now uploadMedia (renamed)


  // --- Push Notifications ---
  registerPushToken: (token: string, pushToken: string) =>
    request<{ status: string }>('/api/v1/push/register', { method: 'POST', body: { token: pushToken }, token }),

  unregisterPushToken: (token: string) =>
    request<{ status: string }>('/api/v1/push/unregister', { method: 'POST', body: {}, token }),


  // --- Groups ---
  createGroup: (token: string, name: string, memberIds: string[], description?: string) =>
    request<{ id: string; name: string; owner_id: string; members: unknown[]; member_count: number }>(
      '/api/v1/groups', { method: 'POST', body: { name, member_ids: memberIds, description }, token }
    ),

  listGroups: (token: string) =>
    request<{ id: string; name: string; owner_id: string; member_count: number; avatar_url?: string }[]>(
      '/api/v1/groups', { token }
    ),

  getGroup: (token: string, groupId: string) =>
    request<{ id: string; name: string; owner_id: string; description?: string; announcement?: string; muted_all?: boolean; avatar_url?: string; members: { citizen_id: string; display_name: string; role: string; avatar_url?: string; citizen_type: string }[]; member_count: number }>(
      `/api/v1/groups/${groupId}`, { token }
    ),

  updateGroup: (token: string, groupId: string, body: { name?: string; description?: string; announcement?: string; avatar_url?: string; muted_all?: boolean }) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}`, { method: 'PUT', body, token }),

  inviteGroupMembers: (token: string, groupId: string, citizenIds: string[]) =>
    request<{ added: number }>(`/api/v1/groups/${groupId}/members`, { method: 'POST', body: { citizen_ids: citizenIds }, token }),

  leaveGroup: (token: string, groupId: string) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}/leave`, { method: 'POST', token }),

  disbandGroup: (token: string, groupId: string) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}`, { method: 'DELETE', token }),

  removeGroupMember: (token: string, groupId: string, citizenId: string) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}/members/${citizenId}`, { method: 'DELETE', token }),

  updateGroupMemberRole: (token: string, groupId: string, citizenId: string, role: 'admin' | 'member') =>
    request<{ status: string }>(`/api/v1/groups/${groupId}/members/${citizenId}/role`, { method: 'PUT', body: { role }, token }),

  transferGroupOwnership: (token: string, groupId: string, citizenId: string) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}/transfer`, { method: 'POST', body: { citizen_id: citizenId }, token }),

  toggleGroupMuteAll: (token: string, groupId: string, muted: boolean) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}/mute-all`, { method: 'POST', body: { muted }, token }),

  getDMHistory: (token: string, peerId: string, before?: string, limit?: number) => {
    const params = new URLSearchParams({ peer: peerId });
    if (before) params.append('before', before);
    if (limit) params.append('limit', String(limit));
    return request<{ id: string; sender_id: string; sender_name: string; to_id: string; payload: any; created_at: string }[]>(
      `/api/v1/messages/history?${params.toString()}`, { token }
    );
  },

  getGroupMessages: (token: string, groupId: string, before?: string) => {
    const params = before ? `?before=${encodeURIComponent(before)}` : '';
    return request<{ id: string; group_id: string; sender_id: string; sender_name: string; avatar_url?: string; payload: unknown; created_at: string }[]>(
      `/api/v1/groups/${groupId}/messages${params}`, { token }
    );
  },

  searchMessages: (token: string, q: string, limit = 30) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return request<{ results: MessageSearchResult[] }>(`/api/v1/messages/search?${params.toString()}`, { token });
  },
};

export function createWebSocket(token: string): WebSocket {
  return new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
}

export default api;
