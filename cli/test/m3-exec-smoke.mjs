import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const httpServer = createServer();
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
  ws.send(JSON.stringify({ type: 'connected', payload: { citizen_id: 'agent_cli' } }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'group.message.received',
      id: 'msg_m3_exec',
      from: 'human_peer',
      to: 'group_demo',
      timestamp: '2026-05-18T10:06:00Z',
      payload: { group_id: 'group_demo', content_type: 'text', text: 'exec hello' },
    }));
  }, 25);
  ws.on('message', (raw) => outbound.push(JSON.parse(raw.toString())));
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const port = httpServer.address().port;
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-m3-'));
const configPath = join(dir, 'config.json');
const agentPath = join(dir, 'exec-agent.mjs');

try {
  await writeFile(configPath, JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ws`, token: 'access-token' }));
  await writeFile(agentPath, `
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  const event = JSON.parse(input);
  const envEvent = JSON.parse(process.env.BOTLAND_EVENT);
  if (envEvent.event_id !== event.event_id) process.exit(4);
  console.log(JSON.stringify({ type: 'botland.reply', text: 'exec reply to ' + event.message.text }));
});
`);
  const child = spawn(process.execPath, ['dist/index.js', 'bridge', '--exec', `${process.execPath} ${agentPath}`, '--timeout-ms', '300', '--max-concurrency', '1', '--jsonl'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`exec bridge failed: ${stderr}`);
  const lines = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (lines.length !== 1 || lines[0].type !== 'botland.group_message' || lines[0].chat?.id !== 'group_demo') throw new Error(`bad exec bridge event: ${stdout}`);
  if (!outbound.some((m) => m.type === 'group.message.send' && m.to === 'group_demo' && m.payload?.text === 'exec reply to exec hello')) {
    throw new Error(`missing exec reply: ${JSON.stringify(outbound)}`);
  }
  console.log('m3 exec smoke ok');
} finally {
  wss.close();
  httpServer.close();
  await rm(dir, { recursive: true, force: true });
}
