import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";

const WS = globalThis.WebSocket;

if (!WS) {
  throw new Error("BotLand plugin requires a global WebSocket implementation (Node 22+)");
}

let _pluginApi = null;
let _runtime = null;
function setPluginApi(api) { _pluginApi = api; }
function getPluginApi() {
  if (!_pluginApi) throw new Error("botland plugin API is not initialized");
  return _pluginApi;
}
function setPluginRuntime(runtime) { _runtime = runtime; }
function getRuntime() {
  if (!_runtime) throw new Error("botland plugin runtime is not initialized");
  return _runtime;
}

const CHANNEL_ID = "botland";
const DEFAULT_API_URL = "https://api.botland.im";
const DEFAULT_WS_URL = "wss://api.botland.im/ws";
const DEFAULT_RECONNECT_MS = 5000;
const DEFAULT_PING_INTERVAL_MS = 20000;
const DEFAULT_TIMEOUT_MS = 120000;

let cachedToken = null;
let cachedCitizenId = null;
let _activeWs = null;
const recentInboundDirectKeys = new Map();
const pendingOutboundStatuses = new Map();

function markInboundDirectSeen(key, ttlMs = 60_000) {
  const now = Date.now();
  for (const [existingKey, expiresAt] of recentInboundDirectKeys) {
    if (expiresAt <= now) recentInboundDirectKeys.delete(existingKey);
  }
  const existingExpiry = recentInboundDirectKeys.get(key);
  if (existingExpiry && existingExpiry > now) return true;
  recentInboundDirectKeys.set(key, now + ttlMs);
  return false;
}

function buildInboundDirectDedupKey(msg, text) {
  if (typeof msg?.id === "string" && msg.id.trim()) return `id:${msg.id}`;
  const ts = msg?.ts || msg?.timestamp || "";
  return `sig:${msg?.from || ""}:${msg?.to || ""}:${ts}:${text}`;
}

function settlePendingOutboundStatus(messageId, statusEnvelope) {
  if (!messageId) return false;
  const pending = pendingOutboundStatuses.get(messageId);
  if (!pending) return false;
  pendingOutboundStatuses.delete(messageId);
  clearTimeout(pending.timeoutHandle);
  pending.resolve(statusEnvelope);
  return true;
}

function waitForOutboundStatus(messageId, timeoutMs) {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendingOutboundStatuses.delete(messageId);
      resolve(null);
    }, timeoutMs);
    pendingOutboundStatuses.set(messageId, { resolve, timeoutHandle });
  });
}

async function readWsEventDataAsText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (typeof Blob !== 'undefined' && data instanceof Blob) return Buffer.from(await data.arrayBuffer()).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

async function login(apiUrl, handle, password, log) {
  log?.info?.(`[${CHANNEL_ID}] logging in as ${handle}...`);
  const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle, password }),
  });
  const data = await res.json();
  if (data.access_token) {
    cachedToken = data.access_token;
    cachedCitizenId = data.citizen_id;
    log?.info?.(`[${CHANNEL_ID}] logged in as ${handle} (${data.citizen_id})`);
    return data;
  }
  log?.error?.(`[${CHANNEL_ID}] login failed: ${JSON.stringify(data)}`);
  return null;
}

async function ensureToken(account, log) {
  if (cachedToken) return cachedToken;
  const data = await login(account.apiUrl, account.handle, account.password, log);
  if (!data?.access_token) throw new Error('BotLand login failed');
  return data.access_token;
}

async function sendViaActiveWs({ target, message, media, cfg, accountId, awaitAckMs = 0, maxAttempts = 1 }) {
  const log = getPluginApi()?.logger;
  const account = resolveAccount(cfg, accountId);
  const ws = _activeWs;
  if (!ws || ws.readyState !== WS.OPEN) {
    return { success: false, error: 'BotLand WebSocket is not connected' };
  }
  if (!target) {
    return { success: false, error: 'Missing target' };
  }
  const isGroup = target.startsWith('group:') || target.startsWith('group_');
  const to = isGroup ? target.replace(/^group:/, '') : target;
  const msgType = isGroup ? 'group.message.send' : 'message.send';
  if (!isGroup && message && typeof message === 'object' && message.reaction && typeof message.reaction === 'object') {
    const msgId = `out_${Date.now()}`;
    ws.send(JSON.stringify({ type: 'message.reaction', id: msgId, to, payload: message.reaction }));
    return { success: true, messageId: msgId };
  }
  if (media) {
    try {
      const token = await ensureToken(account, log);
      const { createReadStream } = await import('fs');
      const { basename } = await import('path');
      const mediaPath = media.path || media.filePath || media;
      const filename = typeof mediaPath === 'string' ? basename(mediaPath) : 'file';
      const fileStream = createReadStream(mediaPath);
      const formData = new FormData();
      formData.append('file', fileStream, filename);
      const uploadRes = await fetch(`${account.apiUrl}/api/v1/media/upload?category=chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) {
        throw new Error(uploadData?.error?.message || 'Upload failed');
      }
      ws.send(JSON.stringify({
        type: msgType,
        id: msgId,
        to,
        payload: { content_type: 'image', url: uploadData.url, text: message || '' },
      }));
      return { success: true, messageId: msgId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (message) {
    let lastAckStatus = null;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
      const msgId = `out_${Date.now()}_${attempt}`;
      ws.send(JSON.stringify({ type: msgType, id: msgId, to, payload: { content_type: 'text', text: message } }));
      if (!awaitAckMs || isGroup) {
        return { success: true, messageId: msgId };
      }
      const ack = await waitForOutboundStatus(msgId, awaitAckMs);
      if (ack?.payload?.status === 'delivered' || ack?.payload?.status === 'read') {
        return { success: true, messageId: msgId, status: ack.payload.status };
      }
      lastAckStatus = ack?.payload?.status || null;
      log?.warn?.(
        `[${CHANNEL_ID}] no delivery ack for outbound direct message ${msgId} to ${to} (attempt ${attempt}/${Math.max(1, maxAttempts)})`,
      );
    }
    return {
      success: false,
      error: lastAckStatus
        ? `BotLand outbound text send did not confirm delivery (${lastAckStatus})`
        : 'BotLand outbound text send did not confirm delivery',
    };
  }
  return { success: false, error: 'No message or media provided' };
}

function buildInboundEnvelope({ cfg, runtime, route, channelLabel, fromLabel, body, timestamp }) {
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  return {
    storePath,
    body: runtime.channel.reply.formatAgentEnvelope({
      channel: channelLabel,
      from: fromLabel,
      body,
      timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
    }),
  };
}

function extractReplyText(payload) {
  const visited = new Set();
  const fragments = [];
  const visit = (value) => {
    const direct = typeof value === "string" ? value.trim() : "";
    if (direct) {
      fragments.push(direct);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value.type === "text" && typeof value.text === "string") {
      visit(value.text);
      return;
    }
    for (const key of ["text", "body", "content", "message", "markdown", "channelData"]) {
      if (key in value) visit(value[key]);
    }
  };
  visit(payload);
  return fragments.filter((entry, index) => fragments.indexOf(entry) === index).join("\n\n").trim();
}

function resolveVisibleOutboundPayload(payload) {
  const directText = typeof payload?.text === "string" ? payload.text.trim() : "";
  const mediaUrls = Array.isArray(payload?.mediaUrls)
    ? payload.mediaUrls.filter((entry) => typeof entry === "string" && entry.trim())
    : payload?.mediaUrl
      ? [payload.mediaUrl]
      : [];
  if (directText || mediaUrls.length > 0) {
    return { text: directText, mediaUrls, usedLegacyTextFallback: false };
  }
  const legacyText = extractReplyText(payload);
  return {
    text: legacyText,
    mediaUrls,
    usedLegacyTextFallback: Boolean(legacyText),
  };
}

async function dispatchInboundDirectDm(params) {
  const { account, cfg, from, text, senderName, ws, timestamp } = params;
  const runtime = getRuntime();
  const logger = getPluginApi().logger;
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: from },
  });
  const { storePath, body } = buildInboundEnvelope({
    cfg,
    runtime,
    route,
    channelLabel: "BotLand",
    fromLabel: senderName || from,
    body: text,
    timestamp,
  });
  const messageId = `in_${Date.now()}`;
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: from,
    // For direct DMs, the current conversation target is the peer we should reply to,
    // not the bot account itself. This keeps message-tool default delivery aimed at
    // the sender instead of looping back to the bot's own BotLand ID.
    To: from,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? account.accountId,
    ChatType: "direct",
    ConversationLabel: senderName || from,
    SenderName: senderName || from,
    SenderId: from,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: messageId,
    MessageSidFull: messageId,
    Timestamp: timestamp,
    CommandAuthorized: true,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: from,
  });
  let deliveredContent = false;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(
    () => abortController.abort(new Error(`Timed out after ${account.timeoutMs}ms`)),
    account.timeoutMs,
  );
  try {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (error) =>
        logger.error(
          `[${CHANNEL_ID}] session record error: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload) => {
          const { text: replyText, mediaUrls, usedLegacyTextFallback } =
            resolveVisibleOutboundPayload(payload);
          if (!replyText && mediaUrls.length === 0) {
            logger?.debug?.(`[${CHANNEL_ID}] skipping empty normalized outbound payload`);
            return;
          }
          if (usedLegacyTextFallback) {
            logger?.debug?.(
              `[${CHANNEL_ID}] recovered visible reply text from legacy outbound payload keys for ${from}`,
            );
          }
          deliveredContent = true;
          if (replyText && ws.readyState === WS.OPEN) {
            const result = await sendViaActiveWs({
              target: from,
              message: replyText,
              cfg,
              accountId: account.accountId,
              awaitAckMs: 2000,
              maxAttempts: 2,
            });
            if (!result?.success) {
              throw new Error(result?.error || "BotLand outbound text send failed");
            }
          }
        for (const mediaUrl of mediaUrls) {
          if (ws.readyState !== WS.OPEN) break;
          const result = await sendViaActiveWs({
            target: from,
            message: "",
            media: mediaUrl,
            cfg,
            accountId: account.accountId,
          });
          if (!result?.success) {
              throw new Error(result?.error || "BotLand outbound media send failed");
            }
          }
        },
        onError: (error, info) =>
          logger.error(
            `[${CHANNEL_ID}] dispatcher error kind=${info.kind} message=${error instanceof Error ? error.message : String(error)}`,
          ),
      },
      replyOptions: {
        abortSignal: abortController.signal,
        disableBlockStreaming: true,
        timeoutOverrideSeconds: Math.max(1, Math.ceil(account.timeoutMs / 1000)),
      },
    });
  } finally {
    clearTimeout(timeoutHandle);
    if (!deliveredContent) {
      logger?.warn?.(`[${CHANNEL_ID}] no visible outbound reply content for inbound DM from ${from}`);
    }
  }
}

async function connectBotland(params) {
  const { account, cfg, log, abortSignal, setStatus } = params;
  let retryCount = 0;
  const loginData = await login(account.apiUrl, account.handle, account.password, log);
  if (!loginData?.access_token) {
    setStatus({ running: false, lastError: 'login failed' });
    return;
  }
  cachedToken = loginData.access_token;
  while (!abortSignal.aborted) {
    const wsUrl = `${account.wsUrl}?token=${cachedToken}`;
    const shouldRetry = await new Promise((resolve) => {
      let resolved = false;
      let pingTimer = null;
      const ws = new WS(wsUrl);
      const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };
      const cleanup = () => { if (pingTimer) clearInterval(pingTimer); };
      const onAbort = () => { cleanup(); try { ws.close(1000, 'abort'); } catch {} safeResolve(false); };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        _activeWs = ws;
        retryCount = 0;
        setStatus({ running: true, lastStartAt: Date.now(), lastError: null });
        ws.send(JSON.stringify({ type: 'presence.update', payload: { state: 'online' } }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WS.OPEN) { try { ws.ping(); } catch {} }
        }, account.pingIntervalMs);
      });
      ws.addEventListener('message', (event) => {
        void (async () => {
          let senderId = null;
          try {
            const raw = await readWsEventDataAsText(event.data);
            const msg = JSON.parse(raw);
            if (msg.type === 'message.status') {
              settlePendingOutboundStatus(msg.payload?.message_id, msg);
              return;
            }
            const isDirect = msg.type === 'message.received' && msg.from;
            if (!isDirect) return;
            const text = msg.payload?.text ?? '';
            if (!text.trim()) return;
            if (cachedCitizenId && msg.from === cachedCitizenId) {
              log?.debug?.(`[${CHANNEL_ID}] ignoring echoed self message ${msg.id || '<no-id>'}`);
              return;
            }
            const dedupKey = buildInboundDirectDedupKey(msg, text.trim());
            if (markInboundDirectSeen(dedupKey)) {
              log?.debug?.(`[${CHANNEL_ID}] skipping duplicate inbound direct message ${dedupKey}`);
              return;
            }
            senderId = msg.from;
            const senderName = msg.payload?.sender_name || msg.sender_name || msg.from;
            if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ type: 'typing.start', to: senderId }));
            await dispatchInboundDirectDm({
              account,
              cfg,
              from: senderId,
              text,
              senderName,
              ws,
              timestamp: msg.ts || msg.timestamp || Date.now(),
            });
          } catch (err) {
            log?.error?.(`[${CHANNEL_ID}] inbound processing error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            if (senderId && ws.readyState === WS.OPEN) {
              ws.send(JSON.stringify({ type: 'typing.stop', to: senderId }));
            }
          }
        })();
      });
      ws.addEventListener('close', () => { cleanup(); _activeWs = null; safeResolve(!abortSignal.aborted); });
      ws.addEventListener('error', () => { cleanup(); try { ws.close(); } catch {} });
    });
    if (!shouldRetry) break;
    retryCount += 1;
    setStatus({ running: false, lastError: `reconnecting (${retryCount})` });
    await new Promise(r => setTimeout(r, account.reconnectMs));
  }
}

function resolveAccount(cfg, accountId = null) {
  const root = cfg?.channels?.[CHANNEL_ID] ?? cfg?.channels?.BotLand ?? {};
  const rootEnabled = root.enabled !== false;
  const accounts = root.accounts && typeof root.accounts === 'object' ? root.accounts : null;
  const defaultKey = root.defaultAccount || DEFAULT_ACCOUNT_ID;
  const requestedKey = accountId || defaultKey;
  const chosen = accounts ? (accounts[requestedKey] || accounts[defaultKey] || Object.values(accounts)[0]) : root;
  const configured = Boolean((chosen?.handle || root.handle || '').trim() && (chosen?.password || root.password || '').trim());
  return {
    accountId: requestedKey,
    enabled: chosen?.enabled !== false && rootEnabled,
    configured,
    apiUrl: chosen?.apiUrl || root.apiUrl || DEFAULT_API_URL,
    wsUrl: chosen?.wsUrl || root.wsUrl || DEFAULT_WS_URL,
    handle: chosen?.handle || root.handle || '',
    password: chosen?.password || root.password || '',
    botName: chosen?.botName || root.botName || chosen?.name || 'BotLand Bot',
    reconnectMs: Number(chosen?.reconnectMs || root.reconnectMs || DEFAULT_RECONNECT_MS),
    pingIntervalMs: Number(chosen?.pingIntervalMs || root.pingIntervalMs || DEFAULT_PING_INTERVAL_MS),
    timeoutMs: Number(chosen?.timeoutMs || root.timeoutMs || DEFAULT_TIMEOUT_MS),
  };
}

const botlandPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: 'BotLand',
    selectionLabel: 'BotLand (AI Social Network)',
    detailLabel: 'BotLand',
    docsPath: '/channels/botland',
    docsLabel: 'botland',
    blurb: 'BotLand social network channel for OpenClaw agents.',
    order: 201,
  },
  config: {
    listAccountIds(cfg) {
      const root = cfg?.channels?.[CHANNEL_ID] ?? cfg?.channels?.BotLand ?? {};
      const accounts = root.accounts && typeof root.accounts === 'object' ? Object.keys(root.accounts) : [];
      return accounts.length > 0 ? accounts : [root.defaultAccount || DEFAULT_ACCOUNT_ID];
    },
    resolveAccount,
    defaultAccountId(cfg) {
      const root = cfg?.channels?.[CHANNEL_ID] ?? cfg?.channels?.BotLand ?? {};
      return root.defaultAccount || DEFAULT_ACCOUNT_ID;
    },
    isEnabled(account) {
      return account.enabled;
    },
    isConfigured(account) {
      return account.configured;
    },
    describeAccount(account) {
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        apiUrl: account.apiUrl,
        handle: account.handle || '[missing]',
        botName: account.botName,
        timeoutMs: account.timeoutMs,
      };
    },
  },
  security: {
    resolveDmPolicy: () => ({
      policy: 'open',
      allowFrom: ['*'],
      policyPath: `channels.${CHANNEL_ID}.handle`,
      allowFromPath: `channels.${CHANNEL_ID}.handle`,
      approveHint: 'BotLand account login authorization',
      normalizeEntry: (raw) => raw.trim(),
    }),
  },
  directory: {
    self: async () => cachedCitizenId ? { id: cachedCitizenId, name: cachedToken ? 'online' : 'offline' } : null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      handle: account.handle || '[missing]',
      apiUrl: account.apiUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const log = ctx.log;
      const account = resolveAccount(ctx.cfg, ctx.accountId);
      if (!account.enabled) {
        log?.info?.(`[${CHANNEL_ID}] channel disabled, skipping`);
        return;
      }
      if (!account.configured) {
        log?.warn?.(`[${CHANNEL_ID}] handle/password not configured, skipping`);
        return;
      }
      await connectBotland({
        account,
        cfg: ctx.cfg,
        log,
        abortSignal: ctx.abortSignal,
        setStatus: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
  messaging: {
    normalizeTarget: (target) => target.trim() || undefined,
    targetResolver: {
      looksLikeId: (value) => Boolean(value.trim()),
      hint: '<citizen_id>',
    },
    send: async ({ target, message, media, cfg, accountId }) =>
      await sendViaActiveWs({ target, message, media, cfg, accountId }),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text, accountId }) => {
      const result = await sendViaActiveWs({ target: to, message: text, cfg, accountId });
      if (!result?.success) {
        throw new Error(result?.error || 'BotLand outbound text send failed');
      }
      return { channel: CHANNEL_ID, messageId: result.messageId || '' };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const result = await sendViaActiveWs({
        target: to,
        message: text ?? '',
        media: mediaUrl,
        cfg,
        accountId,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'BotLand outbound media send failed');
      }
      return { channel: CHANNEL_ID, messageId: result.messageId || '' };
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId }) => {
        const result = await sendViaActiveWs({ target: to, message: text, cfg, accountId });
        if (!result?.success) {
          throw new Error(result?.error || 'BotLand outbound text send failed');
        }
        return { ok: true };
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
        const result = await sendViaActiveWs({
          target: to,
          message: text ?? '',
          media: mediaUrl,
          cfg,
          accountId,
        });
        if (!result?.success) {
          throw new Error(result?.error || 'BotLand outbound media send failed');
        }
        return { ok: true };
      },
    },
  },
  setup: {
    resolveAccount,
    inspectAccount(cfg, accountId = null) {
      const account = resolveAccount(cfg, accountId);
      return {
        enabled: account.enabled,
        configured: account.configured,
        handleStatus: account.handle ? 'available' : 'missing',
        passwordStatus: account.password ? 'available' : 'missing',
        accountId: account.accountId,
      };
    },
  },
  async start(ctx) {
    const cfg = ctx.config;
    const log = ctx.logger;
    const account = resolveAccount(cfg);
    if (!account.enabled) return { stop() {} };
    const abortController = new AbortController();
    connectBotland({ account, cfg, log, abortSignal: abortController.signal, setStatus: ctx.setStatus || (() => {}) }).catch((err) => {
      log?.error?.(`[${CHANNEL_ID}] start error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { stop() { abortController.abort(); try { _activeWs?.close?.(1000, 'stop'); } catch {} _activeWs = null; } };
  },
  async sendMessage(ctx, payload) {
    return await sendViaActiveWs({
      target: payload.target,
      message: payload.message,
      media: payload.media,
      cfg: ctx.config,
      accountId: resolveAccount(ctx.config).accountId,
    });
  },
};

const entry = defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: 'BotLand',
  description: 'Connect to BotLand social network',
  plugin: botlandPlugin,
  setRuntime(runtime) { setPluginRuntime(runtime); },
  registerFull(api) { setPluginApi(api); },
});

export default entry;

export { entry as botlandPluginEntry, botlandPlugin };
