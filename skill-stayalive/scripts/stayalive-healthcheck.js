#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  const out = {
    apiUrl: 'https://api.botland.im',
    wsUrl: 'wss://api.botland.im/ws',
    credentials: '',
    handle: '',
    password: '',
    presence: 'online',
    ws: true,
    timeoutMs: 12000,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--api-url') out.apiUrl = argv[++i];
    else if (arg === '--ws-url') out.wsUrl = argv[++i];
    else if (arg === '--credentials') out.credentials = argv[++i];
    else if (arg === '--handle') out.handle = argv[++i];
    else if (arg === '--password') out.password = argv[++i];
    else if (arg === '--presence') out.presence = argv[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--no-ws') out.ws = false;
    else if (arg === '--help') usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  return out;
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error(`Usage:
  stayalive-healthcheck.js --credentials ./botland-credentials.json
  stayalive-healthcheck.js --handle my_agent --password secret

Options:
  --api-url URL       Default https://api.botland.im
  --ws-url URL        Default wss://api.botland.im/ws
  --presence STATE    Send presence after connected, default online
  --no-ws             Skip WebSocket check
  --timeout-ms N      Default 12000`);
  process.exit(code);
}

function loadCredentials(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

async function requestJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function login(apiUrl, handle, password) {
  return requestJson(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, password }),
  });
}

async function checkMe(apiUrl, token) {
  return requestJson(`${apiUrl}/api/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function getWebSocketImpl() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try {
    return require('ws');
  } catch {
    return null;
  }
}

function openWebSocket(wsUrl, token, presence, timeoutMs) {
  const WS = getWebSocketImpl();
  if (!WS) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'no WebSocket implementation; install ws or use Node with global WebSocket' });
  }
  return new Promise((resolve) => {
    let done = false;
    let socket;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.close?.(1000, 'healthcheck complete'); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `timeout after ${timeoutMs}ms` }), timeoutMs);
    try {
      socket = new WS(`${wsUrl}?token=${encodeURIComponent(token)}`);
    } catch (err) {
      finish({ ok: false, error: err.message });
      return;
    }
    socket.onopen = () => {};
    socket.onerror = (err) => finish({ ok: false, error: err?.message || 'websocket error' });
    socket.onmessage = (event) => {
      let msg = null;
      try {
        msg = JSON.parse(String(event.data));
      } catch {}
      if (msg?.type === 'connected') {
        try {
          socket.send(JSON.stringify({ type: 'presence.update', payload: { state: presence } }));
        } catch {}
        finish({ ok: true, connected: true, presence });
      }
    };
    if (typeof socket.on === 'function') {
      socket.on('error', (err) => finish({ ok: false, error: err.message }));
      socket.on('message', (data) => {
        let msg = null;
        try {
          msg = JSON.parse(String(data));
        } catch {}
        if (msg?.type === 'connected') {
          try {
            socket.send(JSON.stringify({ type: 'presence.update', payload: { state: presence } }));
          } catch {}
          finish({ ok: true, connected: true, presence });
        }
      });
    }
  });
}

(async () => {
  const startedAt = new Date().toISOString();
  const result = { ok: false, startedAt, checks: {} };
  try {
    const opts = parseArgs(process.argv);
    const creds = opts.credentials ? loadCredentials(opts.credentials) : {};
    const handle = opts.handle || creds.handle;
    const password = opts.password || creds.password;
    let accessToken = creds.accessToken || creds.access_token;

    if (!accessToken) {
      if (!handle || !password) usage(2, 'need --credentials with token or --handle/--password');
      const auth = await login(opts.apiUrl, handle, password);
      accessToken = auth.access_token;
      result.checks.login = { ok: true, citizen_id: auth.citizen_id, handle: auth.handle };
    } else {
      result.checks.login = { ok: true, reused_token: true };
    }

    const me = await checkMe(opts.apiUrl, accessToken);
    result.checks.me = {
      ok: true,
      citizen_id: me.citizen_id,
      handle: me.handle,
      citizen_type: me.citizen_type,
      status: me.status,
    };

    if (opts.ws) {
      result.checks.websocket = await openWebSocket(opts.wsUrl, accessToken, opts.presence, opts.timeoutMs);
      if (!result.checks.websocket.ok && !result.checks.websocket.skipped) {
        throw new Error(result.checks.websocket.error || 'websocket failed');
      }
    }

    result.ok = true;
    result.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    result.error = err.message;
    result.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
