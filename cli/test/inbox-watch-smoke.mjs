import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const httpServer = createServer();
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
      type: 'message.received',
      id: 'msg_live',
      from: 'human_peer',
      to: 'agent_cli',
      timestamp: '2026-05-18T10:02:00Z',
      payload: { content_type: 'text', text: 'live hello' },
    }));
  }, 25);
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const { port } = httpServer.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');

try {
  await writeFile(configPath, JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ws`, token: 'access-token' }));
  const child = spawn(process.execPath, ['dist/index.js', 'inbox', 'watch', '--timeout-ms', '100', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`inbox watch failed: ${stderr}`);
  const lines = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (lines.length !== 1 || lines[0].id !== 'msg_live' || lines[0].payload?.text !== 'live hello') {
    throw new Error(`bad inbox watch output: ${stdout}`);
  }
  console.log('inbox watch smoke ok');
} finally {
  wss.close();
  httpServer.close();
  await rm(dir, { recursive: true, force: true });
}
