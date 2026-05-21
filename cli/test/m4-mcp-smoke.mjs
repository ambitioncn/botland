import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/api/v1/me') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ citizen_id: 'agent_cli', handle: 'cli_agent', citizen_type: 'agent', display_name: 'CLI Agent' }));
    return;
  }
  if (url.pathname === '/api/v1/friends') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ friends: [{ citizen_id: 'human_peer', handle: 'peer_handle', display_name: 'Peer Human', citizen_type: 'user' }], total: 1 }));
    return;
  }
  if (url.pathname === '/api/v1/discover/search') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ citizen_id: 'human_peer', handle: 'peer_handle', display_name: 'Peer Human', citizen_type: 'user' }], total: 1 }));
    return;
  }
  if (url.pathname === '/api/v1/messages/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'msg_1', sender_id: 'human_peer', sender_name: 'Peer Human', to_id: 'agent_cli', payload: { content_type: 'text', text: 'hi' }, created_at: '2026-05-18T10:00:00Z' }]));
    return;
  }
  if (url.pathname === '/api/v1/messages/send' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      outbound.push({ rest: true, ...JSON.parse(body) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', message_id: 'msg_rest_mcp', to: 'human_peer' }));
    });
    return;
  }
  if (url.pathname === '/api/v1/groups') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ groups: [] }));
    return;
  }
  if (url.pathname === '/api/v1/communities') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ communities: [] }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: url.pathname } }));
});
const wss = new WebSocketServer({ noServer: true });
const outbound = [];
httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== 'access-token') {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected' }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    outbound.push(msg);
    if (msg.type === 'message.send') ws.send(JSON.stringify({ type: 'message.status', payload: { message_id: msg.id, status: 'delivered' } }));
  });
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const port = httpServer.address().port;
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-mcp-'));
const configPath = join(dir, 'config.json');
await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token: 'access-token' }));

const child = spawn(process.execPath, ['dist/index.js', 'mcp', 'stdio'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, BOTLAND_CONFIG: configPath },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const bus = new EventEmitter();
let buffer = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      const msg = JSON.parse(line);
      bus.emit(String(msg.id), msg);
    }
  }
});
child.stderr.on('data', (chunk) => { stderr += chunk; });
let nextId = 1;
async function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const [msg] = await once(bus, String(id));
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result;
}

try {
  const init = await rpc('initialize', { clientInfo: { name: 'smoke' } });
  if (init.serverInfo?.name !== 'botland') throw new Error('bad initialize');
  const listed = await rpc('tools/list', {});
  if (!listed.tools?.some((t) => t.name === 'botland_send_message')) throw new Error('missing send tool');
  const who = await rpc('tools/call', { name: 'botland_whoami', arguments: {} });
  if (!who.content?.[0]?.text.includes('cli_agent')) throw new Error('bad whoami');
  const send = await rpc('tools/call', { name: 'botland_send_message', arguments: { to: 'Peer Human', text: 'hello mcp' } });
  if (!send.content?.[0]?.text.includes('accepted')) throw new Error('bad send');
  if (!outbound.some((m) => m.rest && m.to === 'human_peer' && m.text === 'hello mcp')) throw new Error('missing outbound');
  const resources = await rpc('resources/list', {});
  if (!resources.resources?.some((r) => r.uri === 'botland://me')) throw new Error('missing resource');
  const prompt = await rpc('prompts/get', { name: 'reply_to_botland_message', arguments: { message: 'hi' } });
  if (!prompt.messages?.[0]?.content?.text.includes('hi')) throw new Error('bad prompt');
  console.log('m4 mcp smoke ok');
} finally {
  child.kill('SIGTERM');
  wss.close();
  httpServer.close();
  await rm(dir, { recursive: true, force: true });
  if (stderr) process.stderr.write(stderr);
}
