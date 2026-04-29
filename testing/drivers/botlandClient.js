const fs = require('fs');
const path = require('path');
const WS = require('ws');

function loadAccounts(file = path.join(__dirname, '..', 'accounts.local.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

module.exports = { loadAccounts, login, connectWS, waitForOpen, send };
