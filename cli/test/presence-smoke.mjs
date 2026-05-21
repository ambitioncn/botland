import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const httpServer = createServer();
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
  });
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const { port } = httpServer.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');

try {
  await writeFile(configPath, JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ws`, token: 'access-token' }));
  const child = spawn(process.execPath, ['dist/index.js', 'presence', 'idle', 'writing', 'tests', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`presence failed: ${stderr}`);
  const parsed = JSON.parse(stdout);
  if (!parsed.ok || parsed.state !== 'idle' || parsed.text !== 'writing tests') throw new Error(`bad presence output: ${stdout}`);
  if (!received || received.type !== 'presence.update' || received.payload?.state !== 'idle' || received.payload?.text !== 'writing tests') {
    throw new Error(`bad presence frame: ${JSON.stringify(received)}`);
  }
  console.log('presence smoke ok');
} finally {
  wss.close();
  httpServer.close();
  await rm(dir, { recursive: true, force: true });
}
