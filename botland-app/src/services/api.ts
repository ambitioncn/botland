const BASE_URL = 'https://api.botland.im';

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string;
};

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
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
  register: (body: { handle: string; password: string; display_name: string; challenge_token: string; invite_code?: string }) =>
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


  // --- Media ---
  uploadImage: async (token: string, uri: string, category: 'avatars' | 'moments' | 'chat' = 'moments') => {
    const formData = new FormData();
    const filename = uri.split('/').pop() || 'photo.jpg';
    const match = /\.([\w]+)$/.exec(filename);
    const ext = match ? match[1] : 'jpg';
    const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    formData.append('file', { uri, name: filename, type: mimeType } as unknown as Blob);
    const res = await fetch(`${BASE_URL}/api/v1/media/upload?category=${category}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data as { url: string; filename: string; size: number; content_type: string };
  },


  // --- Push Notifications ---
  registerPushToken: (token: string, pushToken: string) =>
    request<{ status: string }>('/api/v1/push/register', { method: 'POST', body: { token: pushToken }, token }),

  unregisterPushToken: (token: string) =>
    request<{ status: string }>('/api/v1/push/unregister', { method: 'POST', body: {}, token }),

  // --- Bot Cards ---
  resolveBotCard: (input: string) =>
    request<{ card: { id: string; slug: string; code: string; bot: { id: string; slug?: string; name: string; avatar?: string; summary?: string }; human_url: string; agent_url?: string; skill_slug?: string; status: string } }>(
      '/api/v1/bot-cards/resolve', { method: 'POST', body: { input } }
    ),

  getBotCard: (slug: string) =>
    request<{ card: { id: string; slug: string; code: string; bot: { id: string; slug?: string; name: string; avatar?: string; summary?: string }; human_url: string; agent_url?: string; skill_slug?: string; status: string }; metadata?: Record<string, string> }>(
      `/api/v1/bot-cards/${slug}`
    ),

  bindBotCard: (token: string, cardId: string, source: string = 'manual') =>
    request<{ binding: { id: string; card_id: string; citizen_id: string; status: string; bot: { id: string; name: string; slug: string }; created_at: string } }>(
      '/api/v1/bot-cards/bind', { method: 'POST', body: { card_id: cardId, source }, token }
    ),

  getMyBotBindings: (token: string) =>
    request<{ bindings: { id: string; card_id: string; status: string; bot: { name: string; slug: string; avatar?: string }; created_at: string }[] }>(
      '/api/v1/me/bot-bindings', { token }
    ),


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
    request<{ id: string; name: string; owner_id: string; description?: string; avatar_url?: string; members: { citizen_id: string; display_name: string; role: string; avatar_url?: string; citizen_type: string }[]; member_count: number }>(
      `/api/v1/groups/${groupId}`, { token }
    ),

  updateGroup: (token: string, groupId: string, body: { name?: string; description?: string }) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}`, { method: 'PUT', body, token }),

  inviteGroupMembers: (token: string, groupId: string, citizenIds: string[]) =>
    request<{ added: number }>(`/api/v1/groups/${groupId}/members`, { method: 'POST', body: { citizen_ids: citizenIds }, token }),

  leaveGroup: (token: string, groupId: string) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}/leave`, { method: 'POST', token }),

  disbandGroup: (token: string, groupId: string) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}`, { method: 'DELETE', token }),

  removeGroupMember: (token: string, groupId: string, citizenId: string) =>
    request<{ status: string }>(`/api/v1/groups/${groupId}/members/${citizenId}`, { method: 'DELETE', token }),

  getGroupMessages: (token: string, groupId: string, before?: string) => {
    const params = before ? `?before=${encodeURIComponent(before)}` : '';
    return request<{ id: string; group_id: string; sender_id: string; sender_name: string; avatar_url?: string; payload: unknown; created_at: string }[]>(
      `/api/v1/groups/${groupId}/messages${params}`, { token }
    );
  },

  // --- Invite ---
  createInviteCode: (token: string) =>
    request<{ code: string }>('/api/v1/invite-codes', { method: 'POST', token }),
};

export function createWebSocket(token: string): WebSocket {
  return new WebSocket(`wss://api.botland.im/ws?token=${encodeURIComponent(token)}`);
}

export default api;
