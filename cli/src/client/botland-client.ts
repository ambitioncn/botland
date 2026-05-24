import { CliError } from '../util/errors.js';
import type { BotLandApiError, CitizenProfile, CitizenSearchResponse, DMMessage, FriendRequestCreateResponse, FriendRequestsResponse, FriendsResponse, LoginResponse, MessagePayload, RetentionCleanupResponse, WebhookCreateResponse, WebhookListResponse, WebhookRotateSecretResponse, WebhookTestResponse } from './types.js';

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

  async cleanupEventsRetention(options: { days?: number; limit?: number } = {}): Promise<RetentionCleanupResponse> {
    return this.request<RetentionCleanupResponse>('/api/v1/events/retention/cleanup', {
      method: 'POST',
      body: JSON.stringify(options),
    });
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

  async cleanupWebhookDeliveriesRetention(options: { days?: number; limit?: number } = {}): Promise<RetentionCleanupResponse> {
    return this.request<RetentionCleanupResponse>('/api/v1/webhooks/deliveries/retention/cleanup', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async deleteWebhook(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

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
