import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const state = {
  sent: [],
  replies: [],
  acks: [],
  webhooks: [],
  webhookTests: [],
  events: [
    {
      id: 'evt_1',
      event_id: 'evt_1',
      event_type: 'message.received',
      type: 'message.received',
      cursor: 'evt_1',
      created_at: '2026-05-18T20:00:00Z',
      payload: {
        event_id: 'evt_1',
        event_type: 'message.received',
        message: { id: 'msg_in_1', text: 'hello agent', from: { id: 'human_peer' } },
        chat: { type: 'direct', id: 'human_peer' },
      },
    },
  ],
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const body = await readJson(req);

  if (url.pathname === '/api/v1/me' && req.method === 'GET') {
    return json(res, 200, { citizen_id: 'agent_cli', handle: 'cli_agent', citizen_type: 'agent', display_name: 'CLI Agent' });
  }
  if (url.pathname === '/api/v1/discover/search' && req.method === 'GET') {
    return json(res, 200, { results: [{ citizen_id: 'human_peer', handle: 'peer_handle', display_name: 'Peer Human', citizen_type: 'user' }], total: 1 });
  }
  if (url.pathname === '/api/v1/friends' && req.method === 'GET') {
    return json(res, 200, { friends: [{ citizen_id: 'human_peer', handle: 'peer_handle', display_name: 'Peer Human', citizen_type: 'user' }], total: 1 });
  }
  if (url.pathname === '/api/v1/messages/send' && req.method === 'POST') {
    state.sent.push(body);
    return json(res, 202, { status: 'accepted', message_id: `msg_out_${state.sent.length}`, to: body.to });
  }
  if (url.pathname === '/api/v1/events' && req.method === 'GET') {
    return json(res, 200, { events: state.events, next_cursor: 'evt_1' });
  }
  if (url.pathname === '/api/v1/events/retention/cleanup' && req.method === 'POST') {
    return json(res, 200, { status: 'ok', deleted: 2, days: body.days ?? 30, limit: body.limit ?? 50000, scope: 'acked_events' });
  }
  const ackMatch = url.pathname.match(/^\/api\/v1\/events\/([^/]+)\/ack$/);
  if (ackMatch && req.method === 'POST') {
    state.acks.push(ackMatch[1]);
    return json(res, 200, { status: 'acknowledged' });
  }
  const replyMatch = url.pathname.match(/^\/api\/v1\/messages\/([^/]+)\/reply$/);
  if (replyMatch && req.method === 'POST') {
    state.replies.push({ message_id: replyMatch[1], ...body });
    return json(res, 202, { status: 'accepted', message_id: 'msg_reply_1', to: 'human_peer' });
  }
  if (url.pathname === '/api/v1/webhooks' && req.method === 'POST') {
    const webhook = { id: 'wh_1', url: body.url, events: body.events ?? ['*'], enabled: true, secret: 'whsec_test' };
    state.webhooks.push(webhook);
    return json(res, 201, webhook);
  }
  if (url.pathname === '/api/v1/webhooks' && req.method === 'GET') {
    return json(res, 200, { webhooks: state.webhooks.map(({ secret, ...rest }) => rest), total: state.webhooks.length });
  }
  if (url.pathname === '/api/v1/webhooks/wh_1/test' && req.method === 'POST') {
    state.webhookTests.push('wh_1');
    return json(res, 200, { status: 'delivered', attempts: 1, response_status: 204 });
  }
  if (url.pathname === '/api/v1/webhooks/wh_1/rotate-secret' && req.method === 'POST') {
    return json(res, 200, { id: 'wh_1', secret: 'whsec_rotated', rotated: true });
  }
  if (url.pathname === '/api/v1/webhooks/deliveries/retention/cleanup' && req.method === 'POST') {
    return json(res, 200, { status: 'ok', deleted: 4, days: body.days ?? 30, limit: body.limit ?? 50000, scope: 'terminal_webhook_deliveries' });
  }
  if (url.pathname === '/api/v1/groups' && req.method === 'GET') {
    return json(res, 200, { groups: [] });
  }
  if (url.pathname === '/api/v1/communities' && req.method === 'GET') {
    return json(res, 200, { communities: [] });
  }

  return json(res, 404, { error: { code: 'NOT_FOUND', message: url.pathname } });
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const port = httpServer.address().port;
const dir = await mkdtemp(join(tmpdir(), 'botland-e2e-'));
const configPath = join(dir, 'config.json');
const env = { ...process.env, BOTLAND_CONFIG: configPath };

try {
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token: 'access-token' }));

  const send = JSON.parse(await runCli(['send', '--to', 'Peer Human', 'hello', 'rest', '--json'], env));
  if (send.status !== 'accepted' || send.message_id !== 'msg_out_1' || state.sent[0]?.to !== 'human_peer' || state.sent[0]?.text !== 'hello rest') {
    throw new Error(`send path failed: ${JSON.stringify({ send, sent: state.sent })}`);
  }

  const webhook = JSON.parse(await runCli(['webhooks', 'create', '--url', 'https://agent.example/botland', '--events', 'message.received,friend.request', '--json'], env));
  if (webhook.id !== 'wh_1' || webhook.secret !== 'whsec_test') throw new Error(`webhook create failed: ${JSON.stringify(webhook)}`);
  const whTest = JSON.parse(await runCli(['webhooks', 'test', 'wh_1', '--json'], env));
  if (whTest.status !== 'delivered' || state.webhookTests[0] !== 'wh_1') throw new Error(`webhook test failed: ${JSON.stringify(whTest)}`);
  const rotated = JSON.parse(await runCli(['webhooks', 'rotate-secret', 'wh_1', '--json'], env));
  if (!rotated.rotated || rotated.secret !== 'whsec_rotated') throw new Error(`webhook rotate failed: ${JSON.stringify(rotated)}`);

  const events = await api(`/api/v1/events`, { env });
  if (events.events?.[0]?.payload?.message?.id !== 'msg_in_1') throw new Error(`events failed: ${JSON.stringify(events)}`);
  const reply = await api('/api/v1/messages/msg_in_1/reply', { env, method: 'POST', body: { text: 'reply from e2e' } });
  if (reply.message_id !== 'msg_reply_1' || state.replies[0]?.text !== 'reply from e2e') throw new Error(`reply failed: ${JSON.stringify({ reply, replies: state.replies })}`);
  const ack = await api('/api/v1/events/evt_1/ack', { env, method: 'POST' });
  if (ack.status !== 'acknowledged' || state.acks[0] !== 'evt_1') throw new Error(`ack failed: ${JSON.stringify({ ack, acks: state.acks })}`);
  const cleanedEvents = JSON.parse(await runCli(['events', 'cleanup', '--days', '7', '--limit', '10', '--json'], env));
  if (cleanedEvents.deleted !== 2 || cleanedEvents.days !== 7 || cleanedEvents.limit !== 10) throw new Error(`events cleanup failed: ${JSON.stringify(cleanedEvents)}`);
  const cleanedDeliveries = JSON.parse(await runCli(['webhooks', 'cleanup-deliveries', '--days', '14', '--limit', '20', '--json'], env));
  if (cleanedDeliveries.deleted !== 4 || cleanedDeliveries.days !== 14 || cleanedDeliveries.limit !== 20) throw new Error(`deliveries cleanup failed: ${JSON.stringify(cleanedDeliveries)}`);

  const mcpPort = await freePort();
  const mcp = spawn(process.execPath, ['dist/index.js', 'mcp', 'http', '--host', '127.0.0.1', '--port', String(mcpPort)], {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mcpStdout = '';
  let mcpStderr = '';
  mcp.stdout.on('data', (chunk) => { mcpStdout += chunk; });
  mcp.stderr.on('data', (chunk) => { mcpStderr += chunk; });
  const mcpUrl = await waitForMcpUrl(() => mcpStdout, () => mcp.exitCode, () => mcpStderr);
  const mcpReply = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'botland_send_message', arguments: { to: 'Peer Human', text: 'hello mcp http e2e' } } }),
  }).then((r) => r.json());
  if (mcpReply.error || !JSON.stringify(mcpReply.result).includes('accepted') || state.sent.at(-1)?.text !== 'hello mcp http e2e') {
    throw new Error(`mcp http send failed: ${JSON.stringify({ mcpReply, sent: state.sent.at(-1) })}`);
  }
  mcp.kill('SIGTERM');

  console.log('e2e bridge smoke ok');
} finally {
  httpServer.close();
  await rm(dir, { recursive: true, force: true });
}

async function runCli(args, env) {
  const child = spawn(process.execPath, ['dist/index.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`CLI failed ${args.join(' ')}: ${stderr}`);
  return stdout;
}

async function api(path, { env, method = 'GET', body } = {}) {
  const cfg = JSON.parse(await (await import('node:fs/promises')).readFile(env.BOTLAND_CONFIG, 'utf8'));
  const response = await fetch(new URL(path, cfg.baseUrl), {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`API ${path} failed: ${response.status} ${text}`);
  return data;
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForMcpUrl(getStdout, getExitCode, getStderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const match = `${getStdout()} ${getStderr()}`.match(/BotLand MCP HTTP listening on (http:\/\/[^\s]+\/mcp)/);
    if (match) return match[1];
    if (getExitCode() !== null) throw new Error(`MCP exited early: ${getStderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for MCP HTTP: ${getStdout()} ${getStderr()}`);
}

async function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  let body = '';
  for await (const chunk of req) body += chunk;
  return body.trim() ? JSON.parse(body) : {};
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
