const fs = require('fs');
const path = require('path');
const WS = require('ws');

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function isTokenExpired(token, skewSec = 30) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return payload.exp <= now + skewSec;
}

function loadAccounts(file = path.join(__dirname, '..', 'accounts.local.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const tokenCachePath = path.join(__dirname, '..', '.token-cache.json');
function readTokenCache() {
  try { return JSON.parse(fs.readFileSync(tokenCachePath, 'utf8')); } catch { return {}; }
}
function writeTokenCache(cache) {
  fs.writeFileSync(tokenCachePath, JSON.stringify(cache, null, 2));
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(baseUrl, pathname, { method = 'GET', token, body, attempts = 3 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.ok) return data;
    const err = new Error(`request failed: ${res.status} ${method} ${pathname} ${JSON.stringify(data)}`);
    lastErr = err;
    if (res.status !== 429 || i === attempts - 1) throw err;
    const retryAfter = Number(res.headers.get('retry-after') || 0);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1500 * (i + 1);
    await sleep(waitMs);
  }
  throw lastErr;
}

async function login(baseUrl, handle, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`login failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function loginWithRetry(baseUrl, handle, password, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await login(baseUrl, handle, password);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('429') || i === attempts - 1) throw err;
      await sleep(2500 * (i + 1));
    }
  }
  throw lastErr;
}

async function getLogin(baseUrl, handle, password, { force = false } = {}) {
  const cache = readTokenCache();
  const key = `${baseUrl}::${handle}`;
  const cached = cache[key];
  if (!force && cached?.access_token && !isTokenExpired(cached.access_token)) return cached;
  const data = await loginWithRetry(baseUrl, handle, password);
  cache[key] = data;
  writeTokenCache(cache);
  return data;
}

function connectWS(wsUrl, token) {
  return new WS(`${wsUrl}?token=${encodeURIComponent(token)}`);
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

module.exports = { loadAccounts, request, login, loginWithRetry, getLogin, connectWS, waitForOpen, send, sleep };
