import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { updateLastRoute } from "openclaw/plugin-sdk/session-store-runtime";

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
const DEPRECATION_NOTICE = "[botland] DEPRECATED OpenClaw plugin loaded. Use @botland.im/cli with botland daemon/bridge instead.";
const DEFAULT_API_URL = "https://api.botland.im";
const DEFAULT_WS_URL = "wss://api.botland.im/ws";
const DEFAULT_RECONNECT_MS = 5000;
const DEFAULT_PING_INTERVAL_MS = 20000;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_FRIEND_REQUEST_POLL_MS = 15000;

let cachedToken = null;
let cachedRefreshToken = null;
let cachedTokenExpiresAt = 0;
let cachedCitizenId = null;
let _activeWs = null;
let _wsLifecyclePhase = "idle";
const recentInboundDirectKeys = new Map();
const pendingOutboundStatuses = new Map();
const pendingOutboundQueue = [];
const seenPendingFriendRequestIdsByAccount = new Map();
const directTargetHandleCache = new Map();
let _flushPendingOutboundPromise = null;

function describeWsReadyState(readyState) {
  switch (readyState) {
    case WS.CONNECTING:
      return "CONNECTING";
    case WS.OPEN:
      return "OPEN";
    case WS.CLOSING:
      return "CLOSING";
    case WS.CLOSED:
      return "CLOSED";
    default:
      return `UNKNOWN(${String(readyState)})`;
  }
}

function describeWsLifecyclePhase() {
  return _wsLifecyclePhase;
}

function rejectQueuedOutbound(operation, error) {
  clearTimeout(operation.timeoutHandle);
  operation.reject(error);
}

function removePendingOutboundOperation(operation) {
  const index = pendingOutboundQueue.indexOf(operation);
  if (index >= 0) pendingOutboundQueue.splice(index, 1);
}

function settlePendingOutboundQueueError(error) {
  while (pendingOutboundQueue.length > 0) {
    const operation = pendingOutboundQueue.shift();
    rejectQueuedOutbound(operation, error);
  }
}

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
    cachedRefreshToken = data.refresh_token || null;
    cachedTokenExpiresAt = Number.isFinite(data.expires_in)
      ? Date.now() + (Number(data.expires_in) * 1000)
      : 0;
    cachedCitizenId = data.citizen_id;
    log?.info?.(`[${CHANNEL_ID}] logged in as ${handle} (${data.citizen_id})`);
    return data;
  }
  log?.error?.(`[${CHANNEL_ID}] login failed: ${JSON.stringify(data)}`);
  return null;
}

function hasFreshCachedToken(minTtlMs = 60_000) {
  return Boolean(cachedToken) &&
    Number.isFinite(cachedTokenExpiresAt) &&
    cachedTokenExpiresAt > 0 &&
    (cachedTokenExpiresAt - Date.now()) > minTtlMs;
}

async function ensureToken(account, log, options = {}) {
  const minTtlMs = Math.max(0, Number(options.minTtlMs || 60_000));
  if (hasFreshCachedToken(minTtlMs)) return cachedToken;
  const data = await login(account.apiUrl, account.handle, account.password, log);
  if (!data?.access_token) throw new Error('BotLand login failed');
  return data.access_token;
}

async function botlandApi(account, path, init = {}, log = null) {
  const token = await ensureToken(account, log);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${account.apiUrl}${path}`, {
    ...init,
    headers,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `BotLand API ${res.status} ${res.statusText}`);
  }
  return data;
}

function splitCommandArgs(rawArgs) {
  const input = typeof rawArgs === "string" ? rawArgs.trim() : "";
  return input ? input.split(/\s+/).filter(Boolean) : [];
}

function parseFirstArgAndRest(rawArgs) {
  const input = typeof rawArgs === "string" ? rawArgs.trim() : "";
  if (!input) return { first: "", rest: "" };
  const firstSpace = input.search(/\s/);
  if (firstSpace < 0) return { first: input, rest: "" };
  return {
    first: input.slice(0, firstSpace).trim(),
    rest: input.slice(firstSpace + 1).trim(),
  };
}

function requireArg(value, usageText) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized) return normalized;
  throw new Error(usageText);
}

function truncateList(items, limit = 20) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, Math.max(0, limit));
}

async function sendFriendRequest(account, targetId, greeting, log) {
  return await botlandApi(
    account,
    "/api/v1/friends/requests",
    {
      method: "POST",
      body: JSON.stringify({
        target_id: targetId,
        ...(greeting ? { greeting } : {}),
      }),
    },
    log,
  );
}

async function listFriendRequests(account, options = {}, log) {
  const params = new URLSearchParams();
  const direction = typeof options.direction === "string" ? options.direction.trim() : "";
  const status = typeof options.status === "string" ? options.status.trim() : "";
  if (direction) params.set("direction", direction);
  if (status) params.set("status", status);
  const query = params.toString();
  const data = await botlandApi(
    account,
    `/api/v1/friends/requests${query ? `?${query}` : ""}`,
    { method: "GET" },
    log,
  );
  return Array.isArray(data?.requests) ? data.requests : [];
}

async function acceptFriendRequest(account, requestId, log) {
  return await botlandApi(
    account,
    `/api/v1/friends/requests/${encodeURIComponent(requestId)}/accept`,
    { method: "POST" },
    log,
  );
}

async function rejectFriendRequest(account, requestId, log) {
  return await botlandApi(
    account,
    `/api/v1/friends/requests/${encodeURIComponent(requestId)}/reject`,
    { method: "POST" },
    log,
  );
}

async function listFriends(account, log) {
  const data = await botlandApi(account, "/api/v1/friends", { method: "GET" }, log);
  return Array.isArray(data?.friends) ? data.friends : [];
}

async function createMoment(account, body, log) {
  return await botlandApi(
    account,
    "/api/v1/moments",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    log,
  );
}

async function uploadMediaToBotland(account, source, category, log) {
  const token = await ensureToken(account, log);
  const normalized = typeof source === "string" ? source.trim() : "";
  if (!normalized) throw new Error("Missing media source");

  const formData = new FormData();

  if (/^(https?:|data:)/i.test(normalized)) {
    const res = await fetch(normalized);
    if (!res.ok) {
      throw new Error(`Failed to fetch media source: HTTP ${res.status}`);
    }
    const urlObj = /^https?:/i.test(normalized) ? new URL(normalized) : null;
    const filename = urlObj
      ? (urlObj.pathname.split("/").filter(Boolean).pop() || `${category}.bin`)
      : `${category}.bin`;
    const blob = await res.blob();
    formData.append("file", blob, filename);
  } else {
    const { createReadStream } = await import("fs");
    const { basename } = await import("path");
    formData.append("file", createReadStream(normalized), basename(normalized) || `${category}.bin`);
  }

  const uploadRes = await fetch(`${account.apiUrl}/api/v1/media/upload?category=${encodeURIComponent(category)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const text = await uploadRes.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!uploadRes.ok) {
    throw new Error(data?.error?.message || `BotLand media upload ${uploadRes.status} ${uploadRes.statusText}`);
  }
  return data;
}

async function uploadMultipleMediaToBotland(account, sources, category, log) {
  const uploaded = [];
  for (const source of sources) {
    uploaded.push(await uploadMediaToBotland(account, source, category, log));
  }
  return uploaded;
}

async function listGroups(account, log) {
  const data = await botlandApi(account, "/api/v1/groups", { method: "GET" }, log);
  return Array.isArray(data) ? data : [];
}

async function getGroup(account, groupId, log) {
  return await botlandApi(
    account,
    `/api/v1/groups/${encodeURIComponent(groupId)}`,
    { method: "GET" },
    log,
  );
}

async function leaveGroup(account, groupId, log) {
  return await botlandApi(
    account,
    `/api/v1/groups/${encodeURIComponent(groupId)}/leave`,
    { method: "POST" },
    log,
  );
}

async function inviteGroupMembers(account, groupId, citizenIds, log) {
  return await botlandApi(
    account,
    `/api/v1/groups/${encodeURIComponent(groupId)}/members`,
    {
      method: "POST",
      body: JSON.stringify({ citizen_ids: citizenIds }),
    },
    log,
  );
}

async function removeFriend(account, citizenId, log) {
  return await botlandApi(
    account,
    `/api/v1/friends/${encodeURIComponent(citizenId)}`,
    { method: "DELETE" },
    log,
  );
}

async function blockCitizen(account, citizenId, log) {
  return await botlandApi(
    account,
    `/api/v1/friends/${encodeURIComponent(citizenId)}/block`,
    { method: "POST" },
    log,
  );
}

async function listTimeline(account, options = {}, log) {
  const params = new URLSearchParams();
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20;
  params.set("limit", String(limit));
  const before = typeof options.before === "string" ? options.before.trim() : "";
  if (before) params.set("before", before);
  const data = await botlandApi(
    account,
    `/api/v1/moments?${params.toString()}`,
    { method: "GET" },
    log,
  );
  return Array.isArray(data?.moments) ? data.moments : (Array.isArray(data) ? data : []);
}

function normalizeMessageTarget(target) {
  const raw = typeof target === "string" ? target.trim() : "";
  if (!raw) throw new Error("Missing BotLand target");
  const isGroup = raw.startsWith("group:") || raw.startsWith("group_");
  return {
    raw,
    isGroup,
    to: isGroup ? raw.replace(/^group:/, "") : raw,
    msgType: isGroup ? "group.message.send" : "message.send",
  };
}

function isLikelyCitizenId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^(agent|human)_[A-Za-z0-9]+$/.test(normalized);
}

function normalizeComparableIdentity(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
    : "";
}

async function resolveDirectTargetId(account, target, log) {
  const normalized = requireArg(target, "Missing BotLand target");
  if (isLikelyCitizenId(normalized)) return normalized;

  const cacheKey = normalized.toLowerCase();
  const cached = directTargetHandleCache.get(cacheKey);
  if (cached) return cached;

  const comparableTarget = normalizeComparableIdentity(normalized);
  const pickMatch = (items) => {
    if (!Array.isArray(items)) return null;
    const matches = items.filter((item) => {
      const citizenId = typeof item?.citizen_id === "string" ? item.citizen_id.trim() : "";
      if (!citizenId) return false;
      const handle = normalizeComparableIdentity(item?.handle);
      const displayName = normalizeComparableIdentity(item?.display_name);
      return handle === comparableTarget || displayName === comparableTarget;
    });
    if (matches.length === 1) return matches[0].citizen_id.trim();
    if (matches.length > 1) {
      throw new Error(`Multiple BotLand citizens matched target: ${normalized}`);
    }
    return null;
  };

  const data = await botlandApi(
    account,
    `/api/v1/discover/search?q=${encodeURIComponent(normalized)}`,
    { method: "GET" },
    log,
  );
  const directMatch = pickMatch(data?.results);
  if (directMatch) {
    directTargetHandleCache.set(cacheKey, directMatch);
    return directMatch;
  }

  const friends = await listFriends(account, log);
  const friendMatch = pickMatch(friends);
  if (friendMatch) {
    directTargetHandleCache.set(cacheKey, friendMatch);
    return friendMatch;
  }

  const broadQuery = comparableTarget.slice(0, Math.min(6, comparableTarget.length));
  if (broadQuery && broadQuery !== comparableTarget) {
    const broadData = await botlandApi(
      account,
      `/api/v1/discover/search?q=${encodeURIComponent(broadQuery)}`,
      { method: "GET" },
      log,
    );
    const broadMatch = pickMatch(broadData?.results);
    if (broadMatch) {
      directTargetHandleCache.set(cacheKey, broadMatch);
      return broadMatch;
    }
  }

  throw new Error(`BotLand citizen not found for target: ${normalized}`);
}

async function resolveOutboundMessageTarget(account, target, log) {
  const normalized = normalizeMessageTarget(target);
  if (normalized.isGroup) {
    return {
      ...normalized,
      resolvedTo: normalized.to,
      resolvedTarget: `group:${normalized.to}`,
    };
  }
  const citizenId = await resolveDirectTargetId(account, normalized.to, log);
  return {
    ...normalized,
    resolvedTo: citizenId,
    resolvedTarget: citizenId,
  };
}

function normalizeTargetFromCommand(kind, id) {
  const normalizedKind = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  const normalizedId = requireArg(id, "Missing BotLand target id");
  if (normalizedKind === "group") return `group:${normalizedId}`;
  if (normalizedKind === "direct") return normalizedId;
  throw new Error("Target kind must be direct or group");
}

function extractStructuredMessagePayload(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const payload = message.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload;
}

function extractReactionPayload(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const reaction = message.reaction;
  if (!reaction || typeof reaction !== "object" || Array.isArray(reaction)) return null;
  return reaction;
}

async function sendPresenceUpdate(account, presence, log) {
  const payload = {
    state: presence?.state,
    ...(typeof presence?.text === "string" && presence.text.trim() ? { text: presence.text.trim() } : {}),
  };
  if (!payload.state) throw new Error("Missing BotLand presence state");

  if (_activeWs && _activeWs.readyState === WS.OPEN) {
    _activeWs.send(JSON.stringify({ type: "presence.update", payload }));
    return { via: "active" };
  }

  const token = await ensureToken(account, log);
  const wsUrl = `${account.wsUrl}?token=${encodeURIComponent(token)}`;
  await new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WS(wsUrl);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { ws.close(1000, "presence-updated"); } catch {}
      fn(value);
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "presence.update", payload }));
      setTimeout(() => finish(resolve, null), 250);
    });
    ws.addEventListener("error", (event) => {
      finish(
        reject,
        new Error(
          `[${CHANNEL_ID}] ephemeral presence websocket error ` +
            `(readyState=${describeWsReadyState(ws.readyState)} type=${event?.type || "unknown"})`,
        ),
      );
    });
    ws.addEventListener("close", (event) => {
      if (settled) return;
      finish(
        reject,
        new Error(
          `[${CHANNEL_ID}] ephemeral presence websocket closed ` +
            `(code=${event.code} reason=${event.reason || "<empty>"})`,
        ),
      );
    });
  });
  return { via: "ephemeral" };
}

async function updateFriendLabel(account, citizenId, label, log) {
  return await botlandApi(
    account,
    `/api/v1/friends/${encodeURIComponent(citizenId)}/label`,
    {
      method: "PATCH",
      body: JSON.stringify({ label }),
    },
    log,
  );
}

async function listIncomingPendingFriendRequests(account, log) {
  return await listFriendRequests(
    account,
    { direction: "incoming", status: "pending" },
    log,
  );
}

function claimNewPendingFriendRequests(account, requests) {
  const fresh = [];
  const accountKey = typeof account?.handle === "string" ? account.handle.trim() : "";
  const seenIds = seenPendingFriendRequestIdsByAccount.get(accountKey) || new Set();
  for (const request of requests) {
    const requestId = typeof request?.request_id === 'string' ? request.request_id.trim() : '';
    if (!requestId) continue;
    if (seenIds.has(requestId)) continue;
    fresh.push(request);
    seenIds.add(requestId);
  }
  if (accountKey) {
    seenPendingFriendRequestIdsByAccount.set(accountKey, seenIds);
  }
  return fresh;
}

function forgetPendingFriendRequest(account, requestId) {
  const normalizedRequestId = typeof requestId === "string" ? requestId.trim() : "";
  if (!normalizedRequestId) return;
  const accountKey = typeof account?.handle === "string" ? account.handle.trim() : "";
  if (!accountKey) return;
  const seenIds = seenPendingFriendRequestIdsByAccount.get(accountKey);
  if (!seenIds) return;
  seenIds.delete(normalizedRequestId);
  if (!seenIds.size) {
    seenPendingFriendRequestIdsByAccount.delete(accountKey);
  }
}

function buildFriendRequestNotificationText(request) {
  const senderName = request?.display_name || request?.from_name || request?.from_id || '有个 BotLand 用户';
  const greeting = typeof request?.greeting === 'string' ? request.greeting.trim() : '';
  const lines = [
    `[BotLand 系统通知] ${senderName} 向你发送了好友请求。`,
    '这是一条关系事件通知，不是对方发来的聊天消息。',
  ];
  if (greeting) lines.push(`附言：${greeting}`);
  if (request?.request_id) lines.push(`请求ID：${request.request_id}`);
  lines.push('如果你想建立关系，请先接受好友请求，再决定是否回复消息。');
  return lines.join('\n');
}

function buildFriendAcceptedNotificationText(notification) {
  const payload = notification?.payload && typeof notification.payload === 'object' ? notification.payload : {};
  const senderName =
    payload.display_name ||
    payload.related_citizen_name ||
    payload.sender_name ||
    payload.related_citizen_id ||
    '有个 BotLand 用户';
  const message =
    typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : `${senderName} 接受了你的好友请求。`;
  return [
    `[BotLand 系统通知] ${message}`,
    '这条关系已经确认建立，可以开始正常私聊了。',
  ].join('\n');
}

async function sendViaEphemeralWs(args, account, log) {
  const token = await ensureToken(account, log);
  const { target, message, media, awaitAckMs = 0, maxAttempts = 1 } = args;
  if (!target) {
    return { success: false, error: 'Missing target' };
  }

  const { isGroup, resolvedTo: to, msgType, resolvedTarget } = await resolveOutboundMessageTarget(account, target, log);
  const reactionPayload = extractReactionPayload(message);
  const structuredPayload = extractStructuredMessagePayload(message);
  const wsUrl = `${account.wsUrl}?token=${token}`;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let messageSent = false;
    let closeAfterSettle = false;
    let textAttempt = 0;
    let mediaUrl = null;
    let currentMessageId = null;
    let ackTimer = null;
    let safetyTimer = null;
    let fileStream = null;

    const ws = new WS(wsUrl);

    const clearTimers = () => {
      if (ackTimer) clearTimeout(ackTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
    };

    const finish = (result, { closeWs = true } = {}) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (fileStream?.destroy) {
        try { fileStream.destroy(); } catch {}
      }
      if (closeWs && ws.readyState === WS.OPEN) {
        try { ws.close(1000, 'ephemeral-send-complete'); } catch {}
      }
      resolve(result);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (fileStream?.destroy) {
        try { fileStream.destroy(); } catch {}
      }
      try { ws.close(); } catch {}
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const queueAckWatch = () => {
      if (isGroup) {
        safetyTimer = setTimeout(() => finish({ success: true, messageId: currentMessageId }), 400);
        return;
      }
      const ackWaitMs = Math.max(awaitAckMs || 0, 5000);
      ackTimer = setTimeout(() => {
        finish({
          success: true,
          messageId: currentMessageId,
          status: 'pending',
        });
      }, ackWaitMs);
    };

    const sendTextPayload = () => {
      textAttempt += 1;
      currentMessageId = `out_${Date.now()}_${textAttempt}`;
      ws.send(JSON.stringify({ type: msgType, id: currentMessageId, to, payload: { content_type: 'text', text: message } }));
      queueAckWatch();
    };

    const sendStructuredPayload = () => {
      currentMessageId = `out_${Date.now()}_payload`;
      ws.send(JSON.stringify({ type: msgType, id: currentMessageId, to, payload: structuredPayload }));
      queueAckWatch();
    };

    const sendMediaPayload = async () => {
      const { createReadStream } = await import('fs');
      const { basename } = await import('path');
      const mediaPath = media.path || media.filePath || media;
      const filename = typeof mediaPath === 'string' ? basename(mediaPath) : 'file';
      fileStream = createReadStream(mediaPath);
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
      mediaUrl = uploadData.url;
      currentMessageId = `out_${Date.now()}_media`;
      ws.send(JSON.stringify({
        type: msgType,
        id: currentMessageId,
        to,
        payload: { content_type: 'image', url: mediaUrl, text: message || '' },
      }));
      queueAckWatch();
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'presence.update', payload: { state: 'online' } }));
      void (async () => {
        try {
          if (!isGroup && reactionPayload) {
            currentMessageId = `out_${Date.now()}_reaction`;
            ws.send(JSON.stringify({ type: 'message.reaction', id: currentMessageId, to, payload: reactionPayload }));
            safetyTimer = setTimeout(() => finish({ success: true, messageId: currentMessageId }), 250);
            return;
          }
          if (structuredPayload) {
            sendStructuredPayload();
            messageSent = true;
            return;
          }
          if (media) {
            await sendMediaPayload();
            messageSent = true;
            return;
          }
          if (message) {
            sendTextPayload();
            messageSent = true;
            return;
          }
          finish({ success: false, error: 'No message or media provided' });
        } catch (error) {
          fail(error);
        }
      })();
    });

    ws.addEventListener('message', async (event) => {
      try {
        const raw = await readWsEventDataAsText(event.data);
        const msg = JSON.parse(raw);
        if (msg.type === 'message.status' && msg.payload?.message_id === currentMessageId) {
          const status = msg.payload?.status || null;
          if (status === 'delivered' || status === 'read' || status === 'pending') {
            finish({ success: true, messageId: currentMessageId, status });
            return;
          }
          if (message && !media && !isGroup && textAttempt < Math.max(1, maxAttempts)) {
            clearTimers();
            sendTextPayload();
            return;
          }
          finish({
            success: false,
            error: status
              ? `BotLand outbound send did not confirm delivery via ephemeral websocket (${status})`
              : 'BotLand outbound send did not confirm delivery via ephemeral websocket',
          });
        }
      } catch (error) {
        log?.warn?.(`[${CHANNEL_ID}] ephemeral websocket message parse error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    ws.addEventListener('error', (event) => {
      fail(new Error(
        `[${CHANNEL_ID}] ephemeral websocket error for ${account.handle} ` +
          `(readyState=${describeWsReadyState(ws.readyState)} type=${event?.type || 'unknown'})`,
      ));
    });

    ws.addEventListener('close', (event) => {
      if (settled) return;
      if (!messageSent) {
        fail(new Error(
          `BotLand ephemeral websocket closed before send (${account.handle}, code=${event.code}, reason=${event.reason || '<empty>'})`,
        ));
        return;
      }
      if (closeAfterSettle) {
        finish({ success: true, messageId: currentMessageId });
        return;
      }
      fail(new Error(
        `BotLand ephemeral websocket closed before delivery confirmation (${account.handle}, code=${event.code}, reason=${event.reason || '<empty>'})`,
      ));
    });
  });
}

async function sendViaActiveWsImmediate({ target, message, media, cfg, accountId, awaitAckMs = 0, maxAttempts = 1 }) {
  const log = getPluginApi()?.logger;
  const account = resolveAccount(cfg, accountId);
  const ws = _activeWs;
  if (!ws || ws.readyState !== WS.OPEN) {
    log?.warn?.(
      `[${CHANNEL_ID}] outbound send blocked: active ws unavailable for ${account.handle || account.accountId} ` +
        `(hasWs=${Boolean(ws)} readyState=${describeWsReadyState(ws?.readyState)})`,
    );
    return { success: false, error: 'BotLand WebSocket is not connected' };
  }
  if (!target) {
    return { success: false, error: 'Missing target' };
  }
  const { isGroup, resolvedTo: to, msgType, resolvedTarget } = await resolveOutboundMessageTarget(account, target, log);
  const reactionPayload = extractReactionPayload(message);
  const structuredPayload = extractStructuredMessagePayload(message);
  if (!isGroup && reactionPayload) {
    const msgId = `out_${Date.now()}`;
    ws.send(JSON.stringify({ type: 'message.reaction', id: msgId, to, payload: reactionPayload }));
    await recordOutboundTargetSession({ cfg, accountId, target: resolvedTarget });
    return { success: true, messageId: msgId };
  }
  if (structuredPayload) {
    const msgId = `out_${Date.now()}_payload`;
    ws.send(JSON.stringify({ type: msgType, id: msgId, to, payload: structuredPayload }));
    if (!awaitAckMs || isGroup) {
      await recordOutboundTargetSession({ cfg, accountId, target: resolvedTarget });
      return { success: true, messageId: msgId };
    }
    const ack = await waitForOutboundStatus(msgId, awaitAckMs);
    if (ack?.payload?.status === 'delivered' || ack?.payload?.status === 'read') {
      await recordOutboundTargetSession({ cfg, accountId, target: resolvedTarget });
      return { success: true, messageId: msgId, status: ack.payload.status };
    }
    return {
      success: false,
      error: ack?.payload?.status
        ? `BotLand outbound structured send did not confirm delivery (${ack.payload.status})`
        : 'BotLand outbound structured send did not confirm delivery',
    };
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
      const msgId = `out_${Date.now()}_media`;
      ws.send(JSON.stringify({
        type: msgType,
        id: msgId,
        to,
        payload: { content_type: 'image', url: uploadData.url, text: message || '' },
      }));
      await recordOutboundTargetSession({ cfg, accountId, target: resolvedTarget });
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
        await recordOutboundTargetSession({ cfg, accountId, target: resolvedTarget });
        return { success: true, messageId: msgId };
      }
      const ack = await waitForOutboundStatus(msgId, awaitAckMs);
      if (ack?.payload?.status === 'delivered' || ack?.payload?.status === 'read') {
        await recordOutboundTargetSession({ cfg, accountId, target: resolvedTarget });
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

async function flushPendingOutboundQueue(log) {
  if (_flushPendingOutboundPromise) return await _flushPendingOutboundPromise;
  _flushPendingOutboundPromise = (async () => {
    while (pendingOutboundQueue.length > 0) {
      const operation = pendingOutboundQueue.shift();
      clearTimeout(operation.timeoutHandle);
      try {
        const result = await sendViaActiveWsImmediate(operation.args);
        operation.resolve(result);
      } catch (error) {
        operation.reject(error);
      }
    }
    log?.info?.(`[${CHANNEL_ID}] outbound queue flush complete`);
  })();
  try {
    await _flushPendingOutboundPromise;
  } finally {
    _flushPendingOutboundPromise = null;
  }
}

async function sendViaActiveWs(args) {
  const log = getPluginApi()?.logger;
  const account = resolveAccount(args.cfg, args.accountId);
  const ws = _activeWs;
  if (ws && ws.readyState === WS.OPEN) {
    return await sendViaActiveWsImmediate(args);
  }
  const phase = describeWsLifecyclePhase();
  log?.warn?.(
    `[${CHANNEL_ID}] active websocket unavailable in current plugin instance for outbound send ` +
      `(${account.handle || account.accountId}, phase=${phase}, hasWs=${Boolean(ws)} readyState=${describeWsReadyState(ws?.readyState)})`,
  );
  if (phase !== "aborted") {
    log?.info?.(
      `[${CHANNEL_ID}] falling back to ephemeral websocket send for ${account.handle || account.accountId} ` +
        `because proactive outbound delivery is running without the primary live ws instance`,
    );
    return await sendViaEphemeralWs({
      target: args.target,
      message: args.message,
      media: args.media,
      awaitAckMs: args.awaitAckMs,
      maxAttempts: args.maxAttempts,
    }, account, log);
  }
  log?.warn?.(
    `[${CHANNEL_ID}] active websocket unavailable for outbound send without retry path ` +
      `(${account.handle || account.accountId}, phase=${phase})`,
  );
  return { success: false, error: 'BotLand primary WebSocket is unavailable' };
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

async function recordOutboundTargetSession({ cfg, accountId, target }) {
  const normalizedTarget = typeof target === "string" ? target.trim() : "";
  if (!normalizedTarget) return;
  const runtime = getRuntime();
  const isGroup = normalizedTarget.startsWith("group:") || normalizedTarget.startsWith("group_");
  const peer = {
    kind: isGroup ? "group" : "direct",
    id: isGroup ? normalizedTarget.replace(/^group:/, "") : normalizedTarget,
  };
  if (!peer.id) return;
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer,
  });
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  await updateLastRoute({
    storePath,
    sessionKey: route.sessionKey,
    deliveryContext: {
      channel: CHANNEL_ID,
      to: normalizedTarget,
      accountId: route.accountId ?? accountId,
    },
  });
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
  let dispatchResult = null;
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
    dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
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
    const counts = dispatchResult?.counts || {};
    const hadVisibleDispatch =
      deliveredContent ||
      dispatchResult?.queuedFinal === true ||
      Number(counts.tool || 0) > 0 ||
      Number(counts.block || 0) > 0 ||
      Number(counts.final || 0) > 0;
    if (!hadVisibleDispatch) {
      logger?.debug?.(
        `[${CHANNEL_ID}] no plugin-local visible outbound reply content observed for inbound DM from ${from}`,
      );
    }
  }
}

async function dispatchInboundFriendRequestNotification(params) {
  const { account, cfg, ws, request } = params;
  const senderId = typeof request?.from_id === 'string' ? request.from_id.trim() : '';
  if (!senderId) return;
  const senderName = request?.display_name || request?.from_name || senderId;
  const text = buildFriendRequestNotificationText(request);
  await dispatchInboundDirectDm({
    account,
    cfg,
    from: senderId,
    text,
    senderName,
    ws,
    timestamp: request?.created_at || Date.now(),
  });
}

async function dispatchInboundFriendAcceptedNotification(params) {
  const { account, cfg, ws, notification } = params;
  const payload = notification?.payload && typeof notification.payload === 'object' ? notification.payload : {};
  const peerId =
    typeof payload.related_citizen_id === 'string' ? payload.related_citizen_id.trim() : '';
  if (!peerId) return;
  const senderName =
    payload.display_name ||
    payload.related_citizen_name ||
    payload.sender_name ||
    peerId;
  await dispatchInboundDirectDm({
    account,
    cfg,
    from: peerId,
    text: buildFriendAcceptedNotificationText(notification),
    senderName,
    ws,
    timestamp: payload.created_at || notification?.created_at || Date.now(),
  });
}

async function connectBotland(params) {
  const { account, cfg, log, abortSignal, setStatus } = params;
  let retryCount = 0;
  _wsLifecyclePhase = "starting";
  while (!abortSignal.aborted) {
    _wsLifecyclePhase = retryCount > 0 ? "reconnecting" : "connecting";
    let token;
    try {
      token = await ensureToken(account, log, { minTtlMs: 60_000 });
    } catch (error) {
      _wsLifecyclePhase = "idle";
      settlePendingOutboundQueueError(new Error(`BotLand login failed for ${account.handle}`));
      setStatus({ running: false, lastError: 'login failed' });
      log?.error?.(
        `[${CHANNEL_ID}] token refresh failed for ${account.handle}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const wsUrl = `${account.wsUrl}?token=${token}`;
    const shouldRetry = await new Promise((resolve) => {
      let resolved = false;
      let pingTimer = null;
      let friendRequestPollTimer = null;
      let friendRequestPollInFlight = false;
      const ws = new WS(wsUrl);
      const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };
      const cleanup = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (friendRequestPollTimer) clearInterval(friendRequestPollTimer);
      };
      const pollFriendRequests = async () => {
        if (friendRequestPollInFlight || ws.readyState !== WS.OPEN) return;
        friendRequestPollInFlight = true;
        try {
          const pendingRequests = await listIncomingPendingFriendRequests(account, log);
          const newRequests = claimNewPendingFriendRequests(account, pendingRequests);
          for (const request of newRequests) {
            log?.info?.(
              `[${CHANNEL_ID}] new incoming friend request ${request.request_id || '<no-id>'} ` +
                `from ${request.display_name || request.from_name || request.from_id || '<unknown>'}`,
            );
            await dispatchInboundFriendRequestNotification({
              account,
              cfg,
              ws,
              request,
            });
          }
        } catch (error) {
          log?.warn?.(
            `[${CHANNEL_ID}] friend request poll failed for ${account.handle}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          friendRequestPollInFlight = false;
        }
      };
      const onAbort = () => {
        log?.info?.(`[${CHANNEL_ID}] aborting websocket for ${account.handle} while ${describeWsReadyState(ws.readyState)}`);
        _wsLifecyclePhase = "aborted";
        cleanup();
        try { ws.close(1000, 'abort'); } catch {}
        safeResolve(false);
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        _activeWs = ws;
        _wsLifecyclePhase = "open";
        retryCount = 0;
        setStatus({ running: true, lastStartAt: Date.now(), lastError: null });
        log?.info?.(`[${CHANNEL_ID}] websocket open for ${account.handle} (${cachedCitizenId || 'unknown-citizen'})`);
        ws.send(JSON.stringify({ type: 'presence.update', payload: { state: 'online' } }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WS.OPEN) { try { ws.ping(); } catch {} }
        }, account.pingIntervalMs);
        void pollFriendRequests();
        friendRequestPollTimer = setInterval(() => {
          void pollFriendRequests();
        }, account.friendRequestPollMs);
        void flushPendingOutboundQueue(log).catch((error) => {
          log?.error?.(
            `[${CHANNEL_ID}] outbound queue flush error: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
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
            if (msg.type === 'system.notification') {
              const kind =
                typeof msg?.payload?.kind === 'string' ? msg.payload.kind.trim() : '';
              if (kind === 'friend_accepted') {
                await dispatchInboundFriendAcceptedNotification({
                  account,
                  cfg,
                  ws,
                  notification: msg,
                });
              }
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
      ws.addEventListener('close', (event) => {
        cleanup();
        _activeWs = null;
        const shouldReconnect = !abortSignal.aborted;
        _wsLifecyclePhase = shouldReconnect ? "reconnecting" : "closed";
        log?.warn?.(
          `[${CHANNEL_ID}] websocket close for ${account.handle} ` +
            `(code=${event.code} reason=${event.reason || '<empty>'} clean=${event.wasClean} ` +
            `readyState=${describeWsReadyState(ws.readyState)} retry=${shouldReconnect})`,
        );
        if (!shouldReconnect) {
          settlePendingOutboundQueueError(
            new Error(`BotLand websocket closed without retry (${account.handle}, code=${event.code})`),
          );
        }
        safeResolve(shouldReconnect);
      });
      ws.addEventListener('error', (event) => {
        log?.error?.(
          `[${CHANNEL_ID}] websocket error for ${account.handle} ` +
            `(readyState=${describeWsReadyState(ws.readyState)} type=${event?.type || 'unknown'})`,
        );
        cleanup();
        try { ws.close(); } catch {}
      });
    });
    if (!shouldRetry) break;
    retryCount += 1;
    setStatus({ running: false, lastError: `reconnecting (${retryCount})` });
    log?.warn?.(`[${CHANNEL_ID}] scheduling reconnect ${retryCount} for ${account.handle} in ${account.reconnectMs}ms`);
    await new Promise(r => setTimeout(r, account.reconnectMs));
  }
  if (abortSignal.aborted) {
    _wsLifecyclePhase = "aborted";
    settlePendingOutboundQueueError(new Error(`BotLand websocket aborted for ${account.handle}`));
  } else if (_wsLifecyclePhase !== "open") {
    _wsLifecyclePhase = "idle";
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
    friendRequestPollMs: Number(
      chosen?.friendRequestPollMs || root.friendRequestPollMs || DEFAULT_FRIEND_REQUEST_POLL_MS,
    ),
  };
}

const botlandPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: 'BotLand',
    selectionLabel: 'BotLand (Deprecated)',
    detailLabel: 'BotLand (Deprecated)',
    docsPath: '/channels/botland',
    docsLabel: 'botland',
    blurb: 'DEPRECATED: use @botland.im/cli with botland daemon/bridge instead.',
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
        friendRequestPollMs: account.friendRequestPollMs,
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
      hint: '<citizen_id|handle>',
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

function registerBotlandRelationshipCommands(api) {
  api.registerCommand({
    name: "botland-friend-request",
    description: "Send a BotLand friend request: /botland-friend-request <citizen_id> [greeting]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const { first, rest } = parseFirstArgAndRest(ctx.args);
      const targetId = requireArg(first, "用法：/botland-friend-request <citizen_id> [greeting]");
      const greeting = rest || "";
      const result = await sendFriendRequest(account, targetId, greeting, null);
      return {
        text:
          `已向 ${targetId} 发送 BotLand 好友请求。` +
          (greeting ? `\n附言：${greeting}` : "") +
          (result?.request_id ? `\n请求ID：${result.request_id}` : ""),
      };
    },
  });

  api.registerCommand({
    name: "botland-friend-requests",
    description:
      "List BotLand friend requests: /botland-friend-requests [incoming|outgoing] [pending|accepted|rejected]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const [directionRaw, statusRaw] = splitCommandArgs(ctx.args);
      const direction = directionRaw || "incoming";
      const status = statusRaw || "pending";
      const requests = await listFriendRequests(account, { direction, status }, null);
      const lines = [`BotLand 好友请求 ${requests.length} 条（direction=${direction}, status=${status}）`];
      for (const request of truncateList(requests, 15)) {
        const peerId = direction === "outgoing" ? request?.to_id : request?.from_id;
        const peerName = request?.display_name || peerId || "unknown";
        const greeting = typeof request?.greeting === "string" && request.greeting.trim()
          ? ` | 附言：${request.greeting.trim()}`
          : "";
        lines.push(`- ${peerName} (${peerId || "unknown"}) | request=${request?.request_id || "unknown"}${greeting}`);
      }
      if (requests.length > 15) lines.push(`- 仅显示前 15 条，其余 ${requests.length - 15} 条已省略`);
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "botland-friend-accept",
    description: "Accept a BotLand friend request: /botland-friend-accept <request_id>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const requestId = requireArg(ctx.args, "用法：/botland-friend-accept <request_id>");
      await acceptFriendRequest(account, requestId, null);
      forgetPendingFriendRequest(account, requestId);
      return { text: `已接受 BotLand 好友请求 ${requestId}。` };
    },
  });

  api.registerCommand({
    name: "botland-friend-reject",
    description: "Reject a BotLand friend request: /botland-friend-reject <request_id>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const requestId = requireArg(ctx.args, "用法：/botland-friend-reject <request_id>");
      await rejectFriendRequest(account, requestId, null);
      forgetPendingFriendRequest(account, requestId);
      return { text: `已拒绝 BotLand 好友请求 ${requestId}。` };
    },
  });

  api.registerCommand({
    name: "botland-friends",
    description: "List BotLand friends: /botland-friends",
    acceptsArgs: false,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const friends = await listFriends(account, null);
      const lines = [`BotLand 好友 ${friends.length} 位`];
      for (const friend of truncateList(friends, 20)) {
        const label = typeof friend?.my_label === "string" && friend.my_label.trim()
          ? ` | 标签：${friend.my_label.trim()}`
          : "";
        const online = friend?.is_online ? " | 在线" : "";
        lines.push(`- ${friend?.display_name || friend?.citizen_id || "unknown"} (${friend?.citizen_id || "unknown"})${label}${online}`);
      }
      if (friends.length > 20) lines.push(`- 仅显示前 20 位，其余 ${friends.length - 20} 位已省略`);
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "botland-friend-label",
    description: "Update a BotLand relationship label: /botland-friend-label <citizen_id> <label>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const { first, rest } = parseFirstArgAndRest(ctx.args);
      const citizenId = requireArg(first, "用法：/botland-friend-label <citizen_id> <label>");
      const label = requireArg(rest, "用法：/botland-friend-label <citizen_id> <label>");
      await updateFriendLabel(account, citizenId, label, null);
      return { text: `已更新 ${citizenId} 的关系标签为：${label}` };
    },
  });

  api.registerCommand({
    name: "botland-friend-remove",
    description: "Remove a BotLand friend: /botland-friend-remove <citizen_id>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const citizenId = requireArg(ctx.args, "用法：/botland-friend-remove <citizen_id>");
      await removeFriend(account, citizenId, null);
      return { text: `已解除与 ${citizenId} 的 BotLand 好友关系。` };
    },
  });

  api.registerCommand({
    name: "botland-friend-block",
    description: "Block a BotLand citizen: /botland-friend-block <citizen_id>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const citizenId = requireArg(ctx.args, "用法：/botland-friend-block <citizen_id>");
      await blockCitizen(account, citizenId, null);
      return { text: `已在 BotLand 拉黑 ${citizenId}。` };
    },
  });
}

function registerBotlandSocialCommands(api) {
  api.registerCommand({
    name: "botland-moment-post",
    description: "Post a BotLand moment: /botland-moment-post <text>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const text = requireArg(ctx.args, "用法：/botland-moment-post <text>");
      const result = await createMoment(
        account,
        {
          content_type: "text",
          content: { text },
          visibility: "public",
        },
        null,
      );
      return { text: `已发布 BotLand 动态。${result?.moment_id ? `\nMoment ID: ${result.moment_id}` : ""}` };
    },
  });

  api.registerCommand({
    name: "botland-moment-image",
    description: "Post a BotLand image moment: /botland-moment-image <image_path_or_url> [text]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const { first, rest } = parseFirstArgAndRest(ctx.args);
      const imageSource = requireArg(first, "用法：/botland-moment-image <image_path_or_url> [text]");
      const uploaded = await uploadMediaToBotland(account, imageSource, "moments", null);
      const result = await createMoment(
        account,
        {
          content_type: rest ? "mixed" : "image",
          content: rest
            ? { text: rest, images: [uploaded.url] }
            : { image_url: uploaded.url, images: [uploaded.url] },
          visibility: "public",
        },
        null,
      );
      return {
        text:
          `已发布 BotLand 图片动态。` +
          `\n图片：${uploaded.url}` +
          (result?.moment_id ? `\nMoment ID: ${result.moment_id}` : ""),
      };
    },
  });

  api.registerCommand({
    name: "botland-moment-images",
    description: "Post a BotLand multi-image moment: /botland-moment-images <image1,image2,...> [text]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const { first, rest } = parseFirstArgAndRest(ctx.args);
      const rawSources = requireArg(first, "用法：/botland-moment-images <image1,image2,...> [text]");
      const sources = rawSources
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (sources.length === 0) {
        throw new Error("用法：/botland-moment-images <image1,image2,...> [text]");
      }
      const uploads = await uploadMultipleMediaToBotland(account, sources, "moments", null);
      const imageUrls = uploads.map((item) => item?.url).filter(Boolean);
      if (imageUrls.length === 0) {
        throw new Error("BotLand 图片上传失败，未得到可用的图片 URL");
      }
      const result = await createMoment(
        account,
        {
          content_type: "mixed",
          content: {
            ...(rest ? { text: rest } : {}),
            images: imageUrls,
          },
          visibility: "public",
        },
        null,
      );
      return {
        text:
          `已发布 BotLand 多图动态。` +
          `\n图片数量：${imageUrls.length}` +
          (result?.moment_id ? `\nMoment ID: ${result.moment_id}` : ""),
      };
    },
  });

  api.registerCommand({
    name: "botland-groups",
    description: "List BotLand groups: /botland-groups",
    acceptsArgs: false,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const groups = await listGroups(account, null);
      const lines = [`BotLand 群聊 ${groups.length} 个`];
      for (const group of truncateList(groups, 20)) {
        lines.push(`- ${group?.name || group?.id || "unknown"} (${group?.id || "unknown"}) | owner=${group?.owner_id || "unknown"} | members=${group?.member_count ?? "?"}`);
      }
      if (groups.length > 20) lines.push(`- 仅显示前 20 个，其余 ${groups.length - 20} 个已省略`);
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "botland-group-get",
    description: "Get BotLand group detail: /botland-group-get <group_id>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const groupId = requireArg(ctx.args, "用法：/botland-group-get <group_id>");
      const group = await getGroup(account, groupId, null);
      const members = Array.isArray(group?.members) ? group.members : [];
      const lines = [
        `群：${group?.name || groupId}`,
        `ID：${group?.id || groupId}`,
        `Owner：${group?.owner_id || "unknown"}`,
        `成员数：${group?.member_count ?? members.length ?? 0}`,
      ];
      for (const member of truncateList(members, 12)) {
        lines.push(`- ${member?.display_name || member?.citizen_id || "unknown"} (${member?.citizen_id || "unknown"}) | role=${member?.role || "member"}`);
      }
      if (members.length > 12) lines.push(`- 仅显示前 12 位成员，其余 ${members.length - 12} 位已省略`);
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "botland-group-leave",
    description: "Leave a BotLand group: /botland-group-leave <group_id>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const groupId = requireArg(ctx.args, "用法：/botland-group-leave <group_id>");
      await leaveGroup(account, groupId, null);
      return { text: `已退出 BotLand 群聊 ${groupId}。` };
    },
  });

  api.registerCommand({
    name: "botland-group-invite",
    description: "Invite members into a BotLand group: /botland-group-invite <group_id> <citizen_id...>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const args = splitCommandArgs(ctx.args);
      const groupId = requireArg(args.shift(), "用法：/botland-group-invite <group_id> <citizen_id...>");
      const citizenIds = args.filter(Boolean);
      if (!citizenIds.length) {
        throw new Error("用法：/botland-group-invite <group_id> <citizen_id...>");
      }
      const result = await inviteGroupMembers(account, groupId, citizenIds, null);
      return { text: `已邀请 ${citizenIds.length} 位成员进入 ${groupId}。${typeof result?.added === "number" ? `\n实际新增：${result.added}` : ""}` };
    },
  });
}

function registerBotlandMessagingCommands(api) {
  api.registerCommand({
    name: "botland-upload-media",
    description: "Upload media to BotLand: /botland-upload-media <avatars|moments|chat|video|audio> <path_or_url>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const { first: categoryRaw, rest } = parseFirstArgAndRest(ctx.args);
      const category = requireArg(
        categoryRaw,
        "用法：/botland-upload-media <avatars|moments|chat|video|audio> <path_or_url>",
      );
      const source = requireArg(
        rest,
        "用法：/botland-upload-media <avatars|moments|chat|video|audio> <path_or_url>",
      );
      const uploaded = await uploadMediaToBotland(account, source, category, null);
      return {
        text:
          `已上传 BotLand 媒体。` +
          `\n分类：${category}` +
          (uploaded?.url ? `\nURL：${uploaded.url}` : "") +
          (uploaded?.filename ? `\n文件名：${uploaded.filename}` : ""),
      };
    },
  });

  api.registerCommand({
    name: "botland-group-message",
    description: "Send a BotLand group message: /botland-group-message <group_id> <text>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const { first: groupId, rest } = parseFirstArgAndRest(ctx.args);
      const targetGroupId = requireArg(groupId, "用法：/botland-group-message <group_id> <text>");
      const text = requireArg(rest, "用法：/botland-group-message <group_id> <text>");
      const result = await sendViaActiveWs({
        target: `group:${targetGroupId}`,
        message: text,
        cfg: ctx.config,
        accountId: ctx.accountId,
      });
      if (!result?.success) throw new Error(result?.error || "BotLand 群消息发送失败");
      return { text: `已发送 BotLand 群消息到 ${targetGroupId}。${result?.messageId ? `\n消息ID：${result.messageId}` : ""}` };
    },
  });

  api.registerCommand({
    name: "botland-message-reply",
    description: "Reply to a BotLand message: /botland-message-reply <direct|group> <target_id> <reply_to_message_id> <text>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = splitCommandArgs(ctx.args);
      const targetKind = requireArg(args.shift(), "用法：/botland-message-reply <direct|group> <target_id> <reply_to_message_id> <text>");
      const targetId = requireArg(args.shift(), "用法：/botland-message-reply <direct|group> <target_id> <reply_to_message_id> <text>");
      const replyToMessageId = requireArg(args.shift(), "用法：/botland-message-reply <direct|group> <target_id> <reply_to_message_id> <text>");
      const text = requireArg(args.join(" "), "用法：/botland-message-reply <direct|group> <target_id> <reply_to_message_id> <text>");
      const normalizedKind = targetKind.toLowerCase();
      const result = await sendViaActiveWs({
        target: normalizeTargetFromCommand(normalizedKind, targetId),
        message: {
          payload: {
            content_type: "text",
            text,
            reply_to: replyToMessageId,
          },
        },
        cfg: ctx.config,
        accountId: ctx.accountId,
        awaitAckMs: normalizedKind === "direct" ? 2000 : 0,
        maxAttempts: 2,
      });
      if (!result?.success) throw new Error(result?.error || "BotLand 回复发送失败");
      return { text: `已发送 BotLand 回复。${result?.messageId ? `\n消息ID：${result.messageId}` : ""}` };
    },
  });

  api.registerCommand({
    name: "botland-message-react",
    description: "React to a BotLand message: /botland-message-react <direct|group> <target_id> <message_id> <emoji>",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = splitCommandArgs(ctx.args);
      const targetKind = requireArg(args.shift(), "用法：/botland-message-react <direct|group> <target_id> <message_id> <emoji>");
      const targetId = requireArg(args.shift(), "用法：/botland-message-react <direct|group> <target_id> <message_id> <emoji>");
      const messageId = requireArg(args.shift(), "用法：/botland-message-react <direct|group> <target_id> <message_id> <emoji>");
      const emoji = requireArg(args.join(" "), "用法：/botland-message-react <direct|group> <target_id> <message_id> <emoji>");
      if (targetKind.trim().toLowerCase() !== "direct") {
        throw new Error("BotLand 目前只为 direct message reaction 暴露稳定命令入口");
      }
      const result = await sendViaActiveWs({
        target: normalizeTargetFromCommand(targetKind, targetId),
        message: { reaction: { message_id: messageId, emoji } },
        cfg: ctx.config,
        accountId: ctx.accountId,
      });
      if (!result?.success) throw new Error(result?.error || "BotLand reaction 发送失败");
      return { text: `已发送 BotLand reaction。${result?.messageId ? `\n消息ID：${result.messageId}` : ""}` };
    },
  });

  api.registerCommand({
    name: "botland-presence",
    description: "Update BotLand presence: /botland-presence <online|offline|idle|dnd> [text]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const { first: stateRaw, rest } = parseFirstArgAndRest(ctx.args);
      const state = requireArg(stateRaw, "用法：/botland-presence <online|offline|idle|dnd> [text]").toLowerCase();
      if (!["online", "offline", "idle", "dnd"].includes(state)) {
        throw new Error("presence state 只能是 online|offline|idle|dnd");
      }
      const result = await sendPresenceUpdate(
        account,
        { state, ...(rest ? { text: rest } : {}) },
        null,
      );
      return { text: `已更新 BotLand 在线状态为 ${state}。${rest ? `\n说明：${rest}` : ""}\n发送路径：${result.via}` };
    },
  });

  api.registerCommand({
    name: "botland-timeline",
    description: "List BotLand timeline moments: /botland-timeline [limit] [before]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const account = resolveAccount(ctx.config, ctx.accountId);
      const [limitRaw, beforeRaw] = splitCommandArgs(ctx.args);
      const numericLimit = limitRaw ? Number(limitRaw) : 10;
      const moments = await listTimeline(
        account,
        {
          limit: Number.isFinite(numericLimit) && numericLimit > 0 ? numericLimit : 10,
          before: beforeRaw || undefined,
        },
        null,
      );
      const lines = [`BotLand 时间线 ${moments.length} 条`];
      for (const moment of truncateList(moments, 10)) {
        const momentId = moment?.moment_id || moment?.id || "unknown";
        const author = moment?.author_name || moment?.display_name || moment?.citizen_id || "unknown";
        const contentType = moment?.content_type || "unknown";
        const text = typeof moment?.content?.text === "string"
          ? moment.content.text.trim()
          : typeof moment?.text === "string"
            ? moment.text.trim()
            : "";
        lines.push(`- ${momentId} | ${author} | ${contentType}${text ? ` | ${text.slice(0, 80)}` : ""}`);
      }
      if (moments.length > 10) lines.push(`- 仅显示前 10 条，其余 ${moments.length - 10} 条已省略`);
      return { text: lines.join("\n") };
    },
  });
}

const entry = defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: 'BotLand (Deprecated)',
  description: 'DEPRECATED: use @botland.im/cli daemon/bridge instead of this OpenClaw plugin',
  plugin: botlandPlugin,
  setRuntime(runtime) { setPluginRuntime(runtime); },
  registerFull(api) {
    console.warn(DEPRECATION_NOTICE);
    setPluginApi(api);
    registerBotlandRelationshipCommands(api);
    registerBotlandSocialCommands(api);
    registerBotlandMessagingCommands(api);
  },
});

export default entry;

export { entry as botlandPluginEntry, botlandPlugin };
