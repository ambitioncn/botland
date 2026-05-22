import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

let friendRequestsListed = 0;
let friendRequestAccepted = false;

const httpServer = createServer((req, res) => {
  if (req.url === '/api/v1/friends/requests?direction=incoming&status=pending' && req.method === 'GET') {
    friendRequestsListed += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requests: [{
        request_id: 'fr_auto_1',
        from_id: 'human_peer',
        to_id: 'agent_cli',
        greeting: 'hello',
        status: 'pending',
        display_name: 'Human Peer',
      }],
      total: 1,
    }));
    return;
  }
  if (req.url === '/api/v1/friends/requests/fr_auto_1/accept' && req.method === 'POST') {
    friendRequestAccepted = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
const wss = new WebSocketServer({ noServer: true });

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
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'group.message.received',
      id: 'msg_group_live',
      from: 'human_peer',
      to: 'group_demo',
      timestamp: '2026-05-18T10:03:00Z',
      payload: { group_id: 'group_demo', content_type: 'text', text: 'daemon hello' },
    }));
  }, 25);
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const { port } = httpServer.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');
const statePath = join(dir, 'state.jsonl');
const deadLetterPath = join(dir, 'dead.jsonl');

try {
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token: 'access-token' }));
  const child = spawn(process.execPath, [
    'dist/index.js', 'daemon', 'start',
    '--timeout-ms', '250', '--jsonl',
    '--auto-accept-friend-requests', '--friend-request-poll-ms', '1000',
    '--state', statePath, '--dead-letter', deadLetterPath,
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`daemon failed: ${stderr}`);
  const lines = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (lines.length !== 1 || lines[0].event_id !== 'msg_group_live' || lines[0].chat?.type !== 'group' || lines[0].message?.text !== 'daemon hello') {
    throw new Error(`bad daemon output: ${stdout}`);
  }
  if (friendRequestsListed < 1 || !friendRequestAccepted) {
    throw new Error(`friend request auto-accept failed listed=${friendRequestsListed} accepted=${friendRequestAccepted}`);
  }
  console.log('daemon smoke ok');
} finally {
  wss.close();
  httpServer.close();
  await rm(dir, { recursive: true, force: true });
}
