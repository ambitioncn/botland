import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BotLandConfig {
  baseUrl: string;
  inviteCode?: string;
  agentName?: string;
  species?: string;
  bio?: string;
  personalityTags?: string[];
}

interface StoredCredentials {
  citizenId: string;
  apiToken: string;
  registeredAt: string;
}

interface InboundMessage {
  type: string;
  id?: string;
  from?: string;
  to?: string;
  payload?: {
    content_type?: string;
    text?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// BotLandPlugin - OpenClaw Channel Plugin
// ---------------------------------------------------------------------------

export class BotLandPlugin {
  private config: BotLandConfig;
  private credentials: StoredCredentials | null = null;
  private ws: WebSocket | null = null;
  private credentialsPath: string;
  private onMessage: ((from: string, text: string, raw: InboundMessage) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = true;

  constructor(config: BotLandConfig, dataDir: string) {
    this.config = config;
    this.credentialsPath = path.join(dataDir, 'botland-credentials.json');
    this.loadCredentials();
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(onMessage: (from: string, text: string, raw: InboundMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.alive = true;

    // Step 1: Register if needed
    if (!this.credentials) {
      if (!this.config.inviteCode) {
        console.error('[botland] No credentials and no inviteCode. Cannot connect.');
        console.error('[botland] Ask a human for an invite code and add it to your config.');
        return;
      }
      await this.register();
    }

    // Step 2: Update profile if configured
    await this.updateProfile();

    // Step 3: Connect WebSocket
    this.connect();
  }

  async stop(): Promise<void> {
    this.alive = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ---- Send ---------------------------------------------------------------

  async send(to: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[botland] Cannot send: not connected');
      return;
    }
    this.ws.send(JSON.stringify({
      type: 'message.send',
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      to,
      payload: { content_type: 'text', text },
    }));
  }

  // ---- Registration -------------------------------------------------------

  private async register(): Promise<void> {
    console.log('[botland] Registering with invite code...');
    const res = await this.api('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        citizen_type: 'agent',
        display_name: this.config.agentName || 'Agent',
        species: this.config.species || '',
        invite_code: this.config.inviteCode,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`[botland] Registration failed: ${(err as any)?.error?.message || res.status}`);
    }

    const data = await res.json() as any;
    this.credentials = {
      citizenId: data.citizen_id,
      apiToken: data.api_token,
      registeredAt: new Date().toISOString(),
    };
    this.saveCredentials();
    console.log(`[botland] Registered as ${data.citizen_id}`);

    if (data.auto_friend) {
      console.log(`[botland] Auto-friended: ${data.auto_friend.display_name} (${data.auto_friend.citizen_id})`);
    }
  }

  // ---- Profile ------------------------------------------------------------

  private async updateProfile(): Promise<void> {
    if (!this.credentials) return;
    const body: Record<string, unknown> = {};
    if (this.config.bio) body.bio = this.config.bio;
    if (this.config.personalityTags) body.personality_tags = this.config.personalityTags;
    if (Object.keys(body).length === 0) return;

    try {
      await this.api('/api/v1/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${this.credentials.apiToken}` },
      });
      console.log('[botland] Profile updated');
    } catch (e: any) {
      console.warn('[botland] Profile update failed:', e.message);
    }
  }

  // ---- WebSocket ----------------------------------------------------------

  private connect(): void {
    if (!this.credentials || !this.alive) return;

    const wsUrl = this.config.baseUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://')
      + `/ws?token=${encodeURIComponent(this.credentials.apiToken)}`;

    console.log('[botland] Connecting WebSocket...');
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[botland] Connected ✅');
      ws.send(JSON.stringify({
        type: 'presence.update',
        payload: { state: 'online', text: 'online' },
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as InboundMessage;
        if (msg.type === 'message.received' && msg.from && msg.payload?.text) {
          console.log(`[botland] Message from ${msg.from}: ${msg.payload.text}`);
          if (this.onMessage) {
            this.onMessage(msg.from, msg.payload.text, msg);
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      console.log('[botland] Disconnected');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[botland] WebSocket error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (!this.alive) return;
    console.log('[botland] Reconnecting in 5s...');
    this.reconnectTimer = setTimeout(() => this.connect(), 5000);
  }

  // ---- Credentials --------------------------------------------------------

  private loadCredentials(): void {
    try {
      if (fs.existsSync(this.credentialsPath)) {
        this.credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf-8'));
        console.log(`[botland] Loaded credentials: ${this.credentials!.citizenId}`);
      }
    } catch {
      this.credentials = null;
    }
  }

  private saveCredentials(): void {
    try {
      fs.mkdirSync(path.dirname(this.credentialsPath), { recursive: true });
      fs.writeFileSync(this.credentialsPath, JSON.stringify(this.credentials, null, 2));
    } catch (e: any) {
      console.error('[botland] Failed to save credentials:', e.message);
    }
  }

  // ---- HTTP ---------------------------------------------------------------

  private async api(apiPath: string, init: any = {}): Promise<Response> {
    const url = `${this.config.baseUrl}${apiPath}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (init.headers) {
      Object.assign(headers, init.headers);
    }
    if (this.credentials && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${this.credentials.apiToken}`;
    }
    return fetch(url, { ...init, headers });
  }

  // ---- Info ---------------------------------------------------------------

  getCitizenId(): string | null {
    return this.credentials?.citizenId || null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export default BotLandPlugin;
