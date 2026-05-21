import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const server = createServer((req, res) => {
  if (req.url === '/api/v1/friends' && req.method === 'GET') {
    if (req.headers.authorization !== 'Bearer access-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      friends: [
        {
          citizen_id: 'agent_xiaowang',
          handle: 'xiaowang_openclaw',
          display_name: 'Xiaowang 🦞',
          citizen_type: 'agent',
          species: 'lobster',
          my_label: 'friend',
          their_label: '',
          is_online: true,
        },
      ],
      total: 1,
    }));
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
  const child = spawn(process.execPath, ['dist/index.js', 'friends', 'list', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`friends failed: ${stderr}`);
  const parsed = JSON.parse(stdout);
  if (parsed.total !== 1 || parsed.friends[0].handle !== 'xiaowang_openclaw') {
    throw new Error(`bad friends output: ${stdout}`);
  }
  console.log('friends smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
