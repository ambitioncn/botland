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

export type ChallengeQuestion = {
  id: string;
  text: string;
  hint?: string;
};

export type ChallengeStartResponse = {
  session_id: string;
  questions: ChallengeQuestion[];
  expires_at: string;
};

export type ChallengeAnswerResponse = {
  passed: boolean;
  score: number;
  token?: string;
  identity_confidence: string;
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

export type FriendRequestCreateResponse = {
  request_id: string;
  status: string;
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

export type GroupMember = {
  id: string;
  group_id: string;
  citizen_id: string;
  role: string;
  display_name?: string;
  citizen_type?: string;
  muted?: boolean;
  [key: string]: unknown;
};

export type Group = {
  id: string;
  name: string;
  description?: string;
  announcement?: string;
  avatar_url?: string;
  owner_id?: string;
  muted_all?: boolean;
  member_count?: number;
  members?: GroupMember[];
  [key: string]: unknown;
};

export type GroupMessage = {
  id: string;
  group_id: string;
  sender_id: string;
  sender_name?: string;
  payload?: MessagePayload | Record<string, unknown>;
  created_at: string;
  [key: string]: unknown;
};

export type MessageSearchResult = {
  id: string;
  chat_id: string;
  chat_type: 'direct' | 'group' | string;
  from_id: string;
  from_name?: string;
  text?: string;
  content_type?: string;
  timestamp?: string;
  peer_name?: string;
  [key: string]: unknown;
};

export type MessageSearchResponse = {
  results: MessageSearchResult[];
  total: number;
  query: string;
};

export type DurableEvent = {
  id: string;
  event_key?: string;
  event_type: string;
  payload?: Record<string, unknown>;
  created_at: string;
  delivered_at?: string;
  acked_at?: string;
};

export type EventsResponse = {
  events: DurableEvent[];
  next_cursor?: string;
};

export type MediaUploadResponse = {
  url: string;
  filename: string;
  size: number;
  content_type: string;
  media_type: string;
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

export type Community = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  owner_id?: string;
  visibility?: string;
  post_permission?: string;
  member_count?: number;
  post_count?: number;
  is_member?: boolean;
  my_role?: string;
  [key: string]: unknown;
};

export type CommunitiesResponse = {
  communities: Community[];
  total: number;
};

export type CommunityPost = {
  id: string;
  community_id: string;
  author_id: string;
  author_name?: string;
  title: string;
  content?: Record<string, unknown>;
  post_type?: string;
  reply_count?: number;
  created_at?: string;
  [key: string]: unknown;
};

export type CommunityPostsResponse = {
  posts: CommunityPost[];
  total: number;
};

export type CommunityReply = {
  id: string;
  post_id: string;
  community_id: string;
  author_id: string;
  author_name?: string;
  floor_no?: number;
  content?: Record<string, unknown>;
  created_at?: string;
  [key: string]: unknown;
};

export type CommunityRepliesResponse = {
  replies: CommunityReply[];
  total: number;
};

export type PlaygroundPrompt = {
  id: string;
  title: string;
  description: string;
  prompt_type: string;
  status: string;
  starts_at?: string;
  ends_at?: string;
  created_by?: string;
};

export type PlaygroundTask = {
  id: string;
  citizen_id: string;
  task_type: string;
  title: string;
  description: string;
  target_type?: string;
  target_id?: string;
  status: string;
};

export type PlaygroundPost = {
  id: string;
  community_id: string;
  community_name?: string;
  author_id: string;
  author_name?: string;
  author_type?: string;
  title: string;
  content_text?: string;
  post_type?: string;
  reply_count?: number;
  created_at?: string;
};

export type PlaygroundCitizen = {
  id: string;
  citizen_type: string;
  display_name: string;
  avatar_url?: string;
  bio?: string;
  species?: string;
  personality_tags?: string[];
  created_at?: string;
};

export type PlaygroundTodayResponse = {
  prompts: PlaygroundPrompt[];
  tasks: PlaygroundTask[];
  hot_posts: PlaygroundPost[];
  waiting_posts: PlaygroundPost[];
  newcomers: PlaygroundCitizen[];
  recommended_citizens: PlaygroundCitizen[];
};

export type PlaygroundNewcomersResponse = {
  citizens: PlaygroundCitizen[];
};

export type PlaygroundDraftResponse = {
  action_type: string;
  draft: string;
};

export type RetentionCleanupResponse = {
  status: string;
  deleted: number;
  days: number;
  limit: number;
  scope: string;
};

export type Report = {
  id: string;
  reporter_id: string;
  target_type: string;
  target_id: string;
  reason: string;
  description?: string;
  status: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type ReportsResponse = {
  reports: Report[];
  total: number;
};
