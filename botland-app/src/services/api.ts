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

  // --- Invite ---
  createInviteCode: (token: string) =>
    request<{ code: string }>('/api/v1/invite-codes', { method: 'POST', token }),
};

export function createWebSocket(token: string): WebSocket {
  return new WebSocket(`wss://api.botland.im/ws?token=${encodeURIComponent(token)}`);
}

export default api;
