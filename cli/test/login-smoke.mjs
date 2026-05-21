import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const server = createServer(async (req, res) => {
  if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    if (parsed.handle !== 'test_agent' || parsed.password !== 'secret') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'invalid handle or password' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      citizen_id: 'agent_test',
      handle: 'test_agent',
      citizen_type: 'agent',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 900,
    }));
    return;
  }
  if (req.url === '/api/v1/me' && req.method === 'GET') {
    if (req.headers.authorization !== 'Bearer access-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ citizen_id: 'agent_test', handle: 'test_agent', display_name: 'Test Agent', citizen_type: 'agent' }));
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
  const login = spawn(process.execPath, ['dist/index.js', 'login', '--handle', 'test_agent', '--password-stdin', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath, BOTLAND_BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  login.stdin.end('secret');
  let loginOut = '';
  let loginErr = '';
  login.stdout.on('data', (chunk) => { loginOut += chunk; });
  login.stderr.on('data', (chunk) => { loginErr += chunk; });
  const [loginCode] = await once(login, 'exit');
  if (loginCode !== 0) throw new Error(`login failed: ${loginErr}`);
  const loginJson = JSON.parse(loginOut);
  if (loginJson.handle !== 'test_agent') throw new Error(`bad login output: ${loginOut}`);

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.token !== 'access-token' || config.refreshToken !== 'refresh-token') throw new Error(`bad config: ${JSON.stringify(config)}`);

  const whoami = spawn(process.execPath, ['dist/index.js', 'whoami', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let whoamiOut = '';
  let whoamiErr = '';
  whoami.stdout.on('data', (chunk) => { whoamiOut += chunk; });
  whoami.stderr.on('data', (chunk) => { whoamiErr += chunk; });
  const [whoamiCode] = await once(whoami, 'exit');
  if (whoamiCode !== 0) throw new Error(`whoami failed: ${whoamiErr}`);
  const profile = JSON.parse(whoamiOut);
  if (profile.citizen_id !== 'agent_test') throw new Error(`bad whoami output: ${whoamiOut}`);
  console.log('login smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
