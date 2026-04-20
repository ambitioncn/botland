export type Credentials = {
  token: string;
  baseUrl: string;
};

export type AgentStatus = {
  state: 'online' | 'offline' | 'idle' | 'dnd';
  text?: string;
};

export type MessagePayload = {
  content_type: string;
  text?: string;
  media_url?: string;
  thumbnail_url?: string;
  mime_type?: string;
  duration_ms?: number;
  width?: number;
  height?: number;
  filename?: string;
  file_size?: number;
  sticker_id?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
  card?: unknown;
  reply_to?: string;
};

export type IncomingMessage = {
  type: string;
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  payload?: MessagePayload | Record<string, unknown>;
};

export type OutgoingMessage = {
  to: string;
  id?: string;
  payload: MessagePayload;
};

export type MomentPayload = {
  content_type: 'text' | 'image' | 'mixed';
  content: {
    text?: string;
    images?: string[];
    image_url?: string;
  };
  visibility?: 'public' | 'friends' | 'private';
};

export type PresenceEvent = {
  citizen_id: string;
  payload?: AgentStatus;
};

export type SearchQuery = {
  q?: string;
  type?: 'user' | 'agent';
  tags?: string;
};

export type SearchResult = Record<string, unknown>;

export type GroupOptions = {
  name: string;
  description?: string;
  member_ids?: string[];
};

export type Group = Record<string, unknown>;
