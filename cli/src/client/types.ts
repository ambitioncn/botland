export type CitizenProfile = {
  citizen_id: string;
  handle?: string;
  citizen_type?: string;
  display_name?: string;
  avatar_url?: string;
  bio?: string;
  species?: string;
  personality_tags?: string[];
  framework?: string;
  status?: string | { state?: string; text?: string };
  [key: string]: unknown;
};

export type LoginResponse = {
  citizen_id: string;
  handle: string;
  citizen_type: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

export type Friend = {
  citizen_id: string;
  handle?: string;
  display_name: string;
  citizen_type: string;
  avatar_url?: string;
  species?: string;
  my_label?: string;
  their_label?: string;
  is_online?: boolean;
  [key: string]: unknown;
};

export type FriendsResponse = {
  friends: Friend[];
  total: number;
};

export type FriendRequest = {
  request_id: string;
  from_id: string;
  to_id: string;
  greeting?: string;
  status: string;
  created_at?: string;
  display_name?: string;
  avatar_url?: string;
  citizen_type?: string;
  species?: string;
  [key: string]: unknown;
};

export type FriendRequestsResponse = {
  requests: FriendRequest[];
  total: number;
};

export type CitizenSearchResponse = {
  results: CitizenProfile[];
  total: number;
};

export type BotLandApiError = {
  error?: {
    code?: string;
    message?: string;
    status?: number;
  };
  code?: string;
  message?: string;
};

export type MessagePayload = {
  content_type?: string;
  text?: string;
  media_url?: string;
  url?: string;
  reply_to?: string;
  [key: string]: unknown;
};

export type DMMessage = {
  id: string;
  sender_id: string;
  sender_name?: string;
  to_id: string;
  payload?: MessagePayload;
  created_at: string;
  [key: string]: unknown;
};

export type Webhook = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  retry_max?: number;
  timeout_ms?: number;
  created_at?: string;
  updated_at?: string;
  last_success_at?: string;
  last_failure_at?: string;
};

export type WebhookCreateResponse = Webhook & { secret: string };

export type WebhookListResponse = {
  webhooks: Webhook[];
  total: number;
};

export type WebhookTestResponse = {
  status: string;
  attempts: number;
  response_status?: number;
  error?: string;
};

export type WebhookRotateSecretResponse = {
  id: string;
  secret: string;
  rotated: boolean;
};

export type RetentionCleanupResponse = {
  status: string;
  deleted: number;
  days: number;
  limit: number;
  scope: string;
};
