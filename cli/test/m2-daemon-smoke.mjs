import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const secret = 'shared-secret';
let webhookCount = 0;
let signatureOk = false;
let connectionCount = 0;
const outboundReplies = [];

const webhookServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    webhookCount += 1;
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    signatureOk = req.headers['x-botland-signature'] === expected;
    const event = JSON.parse(body);
    if (event.event_id !== 'msg_reconnect_once' || event.message?.text !== 'hello once') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad event' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: { text: 'auto reply' } }));
  });
});
webhookServer.listen(0, '127.0.0.1');
await once(webhookServer, 'listening');
const webhookPort = webhookServer.address().port;

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

function sendInbound(ws) {
  ws.send(JSON.stringify({
    type: 'message.received',
    id: 'msg_reconnect_once',
    from: 'human_peer',
    to: 'agent_cli',
    timestamp: '2026-05-18T10:04:00Z',
    payload: { content_type: 'text', text: 'hello once' },
  }));
}

wss.on('connection', (ws) => {
  connectionCount += 1;
  ws.send(JSON.stringify({ type: 'connected', payload: { citizen_id: 'agent_cli' } }));
  setTimeout(() => sendInbound(ws), 20);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'message.send') outboundReplies.push(msg);
  });
  if (connectionCount === 1) setTimeout(() => ws.close(1011, 'force reconnect'), 160);
});

httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const wsPort = httpServer.address().port;
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-m2-'));
const configPath = join(dir, 'config.json');
const statePath = join(dir, 'state.jsonl');
const deadLetterPath = join(dir, 'dead.jsonl');

try {
  await writeFile(configPath, JSON.stringify({ wsUrl: `ws://127.0.0.1:${wsPort}/ws`, token: 'access-token' }));
  const child = spawn(process.execPath, [
    'dist/index.js', 'daemon', 'start',
    '--adapter', 'webhook', '--url', `http://127.0.0.1:${webhookPort}/events`, '--secret', secret,
    '--state', statePath, '--dead-letter', deadLetterPath,
    '--retries', '0', '--reconnect-max-ms', '80', '--timeout-ms', '650', '--jsonl',
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
  if (code !== 0) throw new Error(`m2 daemon failed: ${stderr}`);
  const lines = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (connectionCount < 2) throw new Error(`daemon did not reconnect: ${connectionCount}`);
  if (lines.length !== 1 || lines[0].event_id !== 'msg_reconnect_once') throw new Error(`dedupe failed output=${stdout}`);
  if (webhookCount !== 1 || !signatureOk) throw new Error(`webhook count/signature failed count=${webhookCount} signature=${signatureOk}`);
  if (outboundReplies.length !== 1 || outboundReplies[0].to !== 'human_peer' || outboundReplies[0].payload?.text !== 'auto reply') {
    throw new Error(`reply failed: ${JSON.stringify(outboundReplies)}`);
  }
  const state = await readFile(statePath, 'utf8');
  if (!state.includes('"type":"seen"') || !state.includes('"type":"outbound"')) throw new Error(`state missing records: ${state}`);
  console.log('m2 daemon smoke ok');
} finally {
  wss.close();
  httpServer.close();
  webhookServer.close();
  await rm(dir, { recursive: true, force: true });
}
