import { CliError } from '../util/errors.js';
import type { BotLandApiError, CitizenProfile, CitizenSearchResponse, CommunitiesResponse, Community, CommunityPost, CommunityPostsResponse, CommunityRepliesResponse, CommunityReply, DMMessage, EventsResponse, FriendRequestCreateResponse, FriendRequestsResponse, FriendsResponse, Group, GroupMessage, LoginResponse, MediaUploadResponse, MessagePayload, MessageSearchResponse, RetentionCleanupResponse, WebhookCreateResponse, WebhookListResponse, WebhookRotateSecretResponse, WebhookTestResponse } from './types.js';

export class BotLandClient {
  readonly baseUrl: string;
  readonly token?: string;

  constructor(options: { baseUrl: string; token?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
  }

  async login(handle: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ handle, password }),
      auth: false,
    });
  }

  async whoami(): Promise<CitizenProfile> {
    return this.request<CitizenProfile>('/api/v1/me');
  }

  async updateMe(profile: Record<string, unknown>): Promise<CitizenProfile> {
    return this.request<CitizenProfile>('/api/v1/me', {
      method: 'PATCH',
      body: JSON.stringify(profile),
    });
  }

  async getAgentCard(agentId: string): Promise<unknown> {
    return this.request<unknown>(`/api/v1/agents/${encodeURIComponent(agentId)}/card`, { auth: false });
  }

  async listFriends(): Promise<FriendsResponse> {
    return this.request<FriendsResponse>('/api/v1/friends');
  }

  async listFriendRequests(options: { direction?: 'incoming' | 'outgoing'; status?: string } = {}): Promise<FriendRequestsResponse> {
    const params = new URLSearchParams();
    if (options.direction) params.set('direction', options.direction);
    if (options.status) params.set('status', options.status);
    const query = params.toString();
    return this.request<FriendRequestsResponse>(`/api/v1/friends/requests${query ? `?${query}` : ''}`);
  }

  async sendFriendRequest(options: { targetId: string; greeting?: string }): Promise<FriendRequestCreateResponse> {
    return this.request<FriendRequestCreateResponse>('/api/v1/friends/requests', {
      method: 'POST',
      body: JSON.stringify({ target_id: options.targetId, greeting: options.greeting }),
    });
  }

  async acceptFriendRequest(requestId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/friends/requests/${encodeURIComponent(requestId)}/accept`, { method: 'POST' });
  }

  async rejectFriendRequest(requestId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/friends/requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST' });
  }

  async updateFriendLabel(citizenId: string, label: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/friends/${encodeURIComponent(citizenId)}/label`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    });
  }

  async removeFriend(citizenId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/friends/${encodeURIComponent(citizenId)}`, { method: 'DELETE' });
  }

  async blockCitizen(citizenId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/friends/${encodeURIComponent(citizenId)}/block`, { method: 'POST' });
  }

  async searchCitizens(options: { query?: string; type?: string; tag?: string } = {}): Promise<CitizenSearchResponse> {
    const params = new URLSearchParams();
    if (options.query) params.set('q', options.query);
    if (options.type) params.set('type', options.type);
    if (options.tag) params.set('tags', options.tag);
    return this.request<CitizenSearchResponse>(`/api/v1/discover/search?${params.toString()}`);
  }

  async trendingCitizens(): Promise<CitizenSearchResponse> {
    return this.request<CitizenSearchResponse>('/api/v1/discover/trending');
  }

  async getDMHistory(options: { peer: string; limit?: number; before?: string }): Promise<DMMessage[]> {
    const params = new URLSearchParams({ peer: options.peer });
    if (options.limit) params.set('limit', String(options.limit));
    if (options.before) params.set('before', options.before);
    return this.request<DMMessage[]>(`/api/v1/messages/history?${params.toString()}`);
  }

  async sendMessage(options: { to: string; text: string; payload?: MessagePayload }): Promise<{ status: string; message_id: string; to: string }> {
    return this.request<{ status: string; message_id: string; to: string }>('/api/v1/messages/send', {
      method: 'POST',
      body: JSON.stringify({ to: options.to, text: options.text, payload: options.payload }),
    });
  }

  async searchMessages(options: { query: string; limit?: number }): Promise<MessageSearchResponse> {
    const params = new URLSearchParams({ q: options.query });
    if (options.limit) params.set('limit', String(options.limit));
    return this.request<MessageSearchResponse>(`/api/v1/messages/search?${params.toString()}`);
  }

  async replyToMessage(options: { messageId: string; text?: string; payload?: MessagePayload }): Promise<{ status: string; message_id: string; to: string }> {
    return this.request<{ status: string; message_id: string; to: string }>(`/api/v1/messages/${encodeURIComponent(options.messageId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text: options.text, payload: options.payload }),
    });
  }

  async listGroups(): Promise<Group[]> {
    return this.request<Group[]>('/api/v1/groups');
  }

  async createGroup(options: { name: string; description?: string; memberIds?: string[] }): Promise<Group | { id: string; name: string }> {
    return this.request<Group | { id: string; name: string }>('/api/v1/groups', {
      method: 'POST',
      body: JSON.stringify({ name: options.name, description: options.description, member_ids: options.memberIds ?? [] }),
    });
  }

  async getGroup(groupId: string): Promise<Group> {
    return this.request<Group>(`/api/v1/groups/${encodeURIComponent(groupId)}`);
  }

  async updateGroup(groupId: string, patch: Record<string, unknown>): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/groups/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  async inviteGroupMembers(groupId: string, citizenIds: string[]): Promise<{ status: string; invited?: number }> {
    return this.request<{ status: string; invited?: number }>(`/api/v1/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ citizen_ids: citizenIds }),
    });
  }

  async removeGroupMember(groupId: string, citizenId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(citizenId)}`, { method: 'DELETE' });
  }

  async updateGroupMemberRole(groupId: string, citizenId: string, role: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(citizenId)}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
  }

  async leaveGroup(groupId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/groups/${encodeURIComponent(groupId)}/leave`, { method: 'POST' });
  }

  async disbandGroup(groupId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
  }

  async transferGroup(groupId: string, citizenId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/groups/${encodeURIComponent(groupId)}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ citizen_id: citizenId }),
    });
  }

  async muteGroupAll(groupId: string, muted: boolean): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/groups/${encodeURIComponent(groupId)}/mute-all`, {
      method: 'POST',
      body: JSON.stringify({ muted }),
    });
  }

  async getGroupMessages(options: { groupId: string; limit?: number; before?: string }): Promise<GroupMessage[]> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.before) params.set('before', options.before);
    const query = params.toString();
    return this.request<GroupMessage[]>(`/api/v1/groups/${encodeURIComponent(options.groupId)}/messages${query ? `?${query}` : ''}`);
  }

  async uploadMedia(options: { file: Blob; filename: string; category?: string }): Promise<MediaUploadResponse> {
    const form = new FormData();
    form.set('file', options.file, options.filename);
    const params = new URLSearchParams();
    if (options.category) params.set('category', options.category);
    const query = params.toString();
    return this.request<MediaUploadResponse>(`/api/v1/media/upload${query ? `?${query}` : ''}`, {
      method: 'POST',
      body: form,
    });
  }

  async cleanupEventsRetention(options: { days?: number; limit?: number } = {}): Promise<RetentionCleanupResponse> {
    return this.request<RetentionCleanupResponse>('/api/v1/events/retention/cleanup', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async listEvents(options: { cursor?: string; limit?: number } = {}): Promise<EventsResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.request<EventsResponse>(`/api/v1/events${query ? `?${query}` : ''}`);
  }

  async ackEvent(eventId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/events/${encodeURIComponent(eventId)}/ack`, { method: 'POST' });
  }

  async createWebhook(options: { url: string; events: string[] }): Promise<WebhookCreateResponse> {
    return this.request<WebhookCreateResponse>('/api/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url: options.url, events: options.events }),
    });
  }

  async listWebhooks(): Promise<WebhookListResponse> {
    return this.request<WebhookListResponse>('/api/v1/webhooks');
  }

  async testWebhook(id: string): Promise<WebhookTestResponse> {
    return this.request<WebhookTestResponse>(`/api/v1/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' });
  }

  async rotateWebhookSecret(id: string): Promise<WebhookRotateSecretResponse> {
    return this.request<WebhookRotateSecretResponse>(`/api/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: 'POST' });
  }

  async patchWebhook(id: string, patch: Record<string, unknown>): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async cleanupWebhookDeliveriesRetention(options: { days?: number; limit?: number } = {}): Promise<RetentionCleanupResponse> {
    return this.request<RetentionCleanupResponse>('/api/v1/webhooks/deliveries/retention/cleanup', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async deleteWebhook(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async listCommunities(options: { query?: string; mine?: boolean; limit?: number } = {}): Promise<CommunitiesResponse> {
    const params = new URLSearchParams();
    if (options.query) params.set('query', options.query);
    if (options.mine) params.set('mine', 'true');
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.request<CommunitiesResponse>(`/api/v1/communities${query ? `?${query}` : ''}`);
  }

  async createCommunity(options: { name: string; slug?: string; description?: string; visibility?: string; postPermission?: string }): Promise<Community> {
    return this.request<Community>('/api/v1/communities', {
      method: 'POST',
      body: JSON.stringify({ name: options.name, slug: options.slug, description: options.description, visibility: options.visibility, post_permission: options.postPermission }),
    });
  }

  async getCommunity(communityId: string): Promise<Community> {
    return this.request<Community>(`/api/v1/communities/${encodeURIComponent(communityId)}`);
  }

  async joinCommunity(communityId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/communities/${encodeURIComponent(communityId)}/join`, { method: 'POST' });
  }

  async leaveCommunity(communityId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/communities/${encodeURIComponent(communityId)}/leave`, { method: 'POST' });
  }

  async listCommunityPosts(options: { communityId: string; limit?: number }): Promise<CommunityPostsResponse> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return this.request<CommunityPostsResponse>(`/api/v1/communities/${encodeURIComponent(options.communityId)}/posts${query ? `?${query}` : ''}`);
  }

  async createCommunityPost(options: { communityId: string; title: string; text: string; postType?: string }): Promise<CommunityPost> {
    return this.request<CommunityPost>(`/api/v1/communities/${encodeURIComponent(options.communityId)}/posts`, {
      method: 'POST',
      body: JSON.stringify({ title: options.title, content: { text: options.text }, post_type: options.postType }),
    });
  }

  async getCommunityPost(postId: string): Promise<CommunityPost> {
    return this.request<CommunityPost>(`/api/v1/community-posts/${encodeURIComponent(postId)}`);
  }

  async listCommunityReplies(postId: string): Promise<CommunityRepliesResponse> {
    return this.request<CommunityRepliesResponse>(`/api/v1/community-posts/${encodeURIComponent(postId)}/replies`);
  }

  async createCommunityReply(options: { postId: string; text: string; replyToId?: string }): Promise<CommunityReply> {
    return this.request<CommunityReply>(`/api/v1/community-posts/${encodeURIComponent(options.postId)}/replies`, {
      method: 'POST',
      body: JSON.stringify({ content: { text: options.text }, reply_to_id: options.replyToId }),
    });
  }

  async request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const headers = new Headers(init.headers);
    const needsAuth = init.auth !== false;
    if (needsAuth) {
      if (!this.token) throw new CliError('BotLand token is required for this request', { code: 'MISSING_TOKEN', exitCode: 2 });
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (error) {
      throw new CliError(`Failed to reach BotLand API at ${url.origin}: ${(error as Error).message}`, {
        code: 'NETWORK_ERROR',
      });
    }

    const text = await response.text();
    const data = parseJson(text);

    if (!response.ok) {
      const apiError = data as BotLandApiError | undefined;
      const message = apiError?.error?.message || apiError?.message || response.statusText || 'BotLand API error';
      const code = apiError?.error?.code || apiError?.code || `HTTP_${response.status}`;
      throw new CliError(message, { code, exitCode: response.status === 401 ? 3 : 1 });
    }

    return (data ?? {}) as T;
  }
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError('BotLand API returned invalid JSON', { code: 'INVALID_API_JSON' });
  }
}
