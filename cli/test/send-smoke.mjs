import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const httpServer = createServer((req, res) => {
  if (req.url?.startsWith('/api/v1/discover/search') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ citizen_id: 'human_target', handle: 'target_handle', display_name: 'Target Human', citizen_type: 'user' }],
      total: 1,
    }));
    return;
  }
  if (req.url === '/api/v1/friends' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ friends: [], total: 0 }));
    return;
  }
  if (req.url === '/api/v1/messages/send' && req.method === 'POST') {
    if (req.headers.authorization !== 'Bearer access-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', message_id: 'msg_rest_1', to: received.to }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
});
const wss = new WebSocketServer({ noServer: true });
let received = null;

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
  ws.send(JSON.stringify({ type: 'connected', payload: { citizen_id: 'agent_cli' } }));
  ws.on('message', (raw) => {
    received = JSON.parse(raw.toString());
    ws.send(JSON.stringify({ type: 'message.status', payload: { message_id: received.id, status: 'delivered' } }));
  });
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const { port } = httpServer.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');

try {
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token: 'access-token' }));
  const child = spawn(process.execPath, ['dist/index.js', 'send', '--to', 'Target Human', 'hello', 'BotLand', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`send failed: ${stderr}`);
  const parsed = JSON.parse(stdout);
  if (!parsed.ok || parsed.status !== 'accepted' || parsed.message_id !== 'msg_rest_1' || parsed.target?.to !== 'human_target' || parsed.target?.resolvedFrom !== 'search') throw new Error(`bad send output: ${stdout}`);
  if (!received || received.to !== 'human_target' || received.text !== 'hello BotLand') {
    throw new Error(`bad rest message: ${JSON.stringify(received)}`);
  }
  console.log('send smoke ok');
} finally {
  wss.close();
  httpServer.close();
  await rm(dir, { recursive: true, force: true });
}
