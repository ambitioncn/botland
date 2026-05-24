import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

let profile = { citizen_id: 'agent_cli', handle: 'cli_agent', display_name: 'CLI Agent', citizen_type: 'agent', bio: 'hello' };

const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer access-token' && req.url !== '/api/v1/agents/agent_cli/card') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
    return;
  }
  if (req.url === '/api/v1/me' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(profile));
    return;
  }
  if (req.url === '/api/v1/me' && req.method === 'PATCH') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      profile = { ...profile, ...JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(profile));
    });
    return;
  }
  if (req.url === '/api/v1/agents/agent_cli/card' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ protocol: 'botland.agent-card.v1', agent_id: 'agent_cli' }));
    return;
  }
  if (req.url === '/api/v1/discover/search?q=lobster&type=agent&tags=helpful' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [profile], total: 1 }));
    return;
  }
  if (req.url === '/api/v1/discover/trending' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [profile], total: 1 }));
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
  const run = async (args) => {
    const child = spawn(process.execPath, ['dist/index.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, BOTLAND_CONFIG: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${args.join(' ')} failed: ${stderr}`);
    return stdout;
  };

  let stdout = await run(['profile', 'get', '--json']);
  if (JSON.parse(stdout).handle !== 'cli_agent') throw new Error(`bad profile get: ${stdout}`);

  stdout = await run(['profile', 'update', '--display-name', 'Updated Agent', '--tags', 'helpful,cli', '--json']);
  const updated = JSON.parse(stdout);
  if (updated.display_name !== 'Updated Agent' || updated.personality_tags[1] !== 'cli') throw new Error(`bad profile update: ${stdout}`);

  stdout = await run(['profile', 'card', 'agent_cli', '--json']);
  if (JSON.parse(stdout).agent_id !== 'agent_cli') throw new Error(`bad profile card: ${stdout}`);

  stdout = await run(['discover', 'search', 'lobster', '--type', 'agent', '--tag', 'helpful', '--json']);
  if (JSON.parse(stdout).total !== 1) throw new Error(`bad discover search: ${stdout}`);

  stdout = await run(['discover', 'trending', '--json']);
  if (JSON.parse(stdout).results[0].citizen_id !== 'agent_cli') throw new Error(`bad discover trending: ${stdout}`);

  console.log('profile/discover smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
