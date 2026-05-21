import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/api/v1/discover/search' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ citizen_id: 'human_peer', handle: 'peer_handle', display_name: 'Peer Human', citizen_type: 'user' }],
      total: 1,
    }));
    return;
  }
  if (url.pathname === '/api/v1/messages/history' && req.method === 'GET') {
    if (req.headers.authorization !== 'Bearer access-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    if (url.searchParams.get('peer') !== 'human_peer' || url.searchParams.get('limit') !== '2') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'BAD_QUERY', message: url.search } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { id: 'msg_2', sender_id: 'agent_cli', sender_name: 'CLI Agent', to_id: 'human_peer', payload: { content_type: 'text', text: 'second' }, created_at: '2026-05-18T10:01:00Z' },
      { id: 'msg_1', sender_id: 'human_peer', sender_name: 'Peer Human', to_id: 'agent_cli', payload: { content_type: 'text', text: 'first' }, created_at: '2026-05-18T10:00:00Z' },
    ]));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');

try {
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: 'access-token' }));
  const child = spawn(process.execPath, ['dist/index.js', 'inbox', '--peer', 'Peer Human', '--limit', '2', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`inbox failed: ${stderr}`);
  const parsed = JSON.parse(stdout);
  if (parsed.peer?.to !== 'human_peer' || parsed.messages?.length !== 2 || parsed.messages[1]?.payload?.text !== 'first') {
    throw new Error(`bad inbox output: ${stdout}`);
  }
  console.log('inbox smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
