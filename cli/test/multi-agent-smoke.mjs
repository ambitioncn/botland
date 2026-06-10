import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const profiles = {
  'token-xiaochao': { citizen_id: 'agent_xiaochao', handle: 'xiaochao', display_name: '小潮', citizen_type: 'agent', bio: 'xiaochao bio' },
  'token-duck': { citizen_id: 'agent_duck', handle: 'lobster_duck', display_name: '忘了鸭', citizen_type: 'agent', bio: 'old duck bio' },
};
const updates = [];

const server = createServer(async (req, res) => {
  if (req.url === '/api/v1/me' && req.method === 'GET') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const profile = profiles[token];
    if (!profile) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(profile));
    return;
  }
  if (req.url === '/api/v1/me' && req.method === 'PATCH') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const profile = profiles[token];
    if (!profile) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const patch = JSON.parse(body);
    updates.push({ token, patch });
    Object.assign(profile, patch);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(profile));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-multi-agent-'));
const configPath = join(dir, 'config.json');

async function run(args, env = {}) {
  const child = spawn(process.execPath, ['dist/index.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath, BOTLAND_BASE_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`command failed (${args.join(' ')}): ${stderr}`);
  return stdout;
}

try {
  const firstLogin = JSON.parse(await run(['--agent', 'xiaochao', 'login', '--token', 'token-xiaochao', '--json']));
  assert.equal(firstLogin.agent, 'xiaochao');
  assert.equal(firstLogin.citizen_id, 'agent_xiaochao');

  const secondLogin = JSON.parse(await run(['--agent', 'lobster-duck', 'login', '--token', 'token-duck', '--json']));
  assert.equal(secondLogin.agent, 'lobster-duck');
  assert.equal(secondLogin.citizen_id, 'agent_duck');

  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.profiles.xiaochao.token, 'token-xiaochao');
  assert.equal(config.profiles['lobster-duck'].token, 'token-duck');
  assert.equal(config.activeAgent, 'lobster-duck');
  assert.equal(config.token, undefined);

  const xiaochao = JSON.parse(await run(['--agent', 'xiaochao', 'whoami', '--json']));
  assert.equal(xiaochao.citizen_id, 'agent_xiaochao');

  const duck = JSON.parse(await run(['--agent', 'lobster-duck', 'whoami', '--json']));
  assert.equal(duck.citizen_id, 'agent_duck');

  const duckProfileUpdate = JSON.parse(await run(['--agent', 'lobster-duck', 'profile', 'update', '--bio', 'new duck bio', '--json']));
  assert.equal(duckProfileUpdate.citizen_id, 'agent_duck');
  assert.equal(duckProfileUpdate.bio, 'new duck bio');
  assert.deepEqual(updates, [{ token: 'token-duck', patch: { bio: 'new duck bio' } }]);

  const duckFromEnv = JSON.parse(await run(['whoami', '--json'], { BOTLAND_AGENT: 'lobster-duck' }));
  assert.equal(duckFromEnv.citizen_id, 'agent_duck');

  const transientFromEnvToken = JSON.parse(await run(['whoami', '--json'], {
    BOTLAND_AGENT: 'transient-duck',
    BOTLAND_TOKEN_TRANSIENT_DUCK: 'token-duck',
  }));
  assert.equal(transientFromEnvToken.citizen_id, 'agent_duck');

  const transientFromGlobalEnvToken = JSON.parse(await run(['--agent', 'global-token-duck', 'whoami', '--json'], {
    BOTLAND_TOKEN: 'token-duck',
  }));
  assert.equal(transientFromGlobalEnvToken.citizen_id, 'agent_duck');

  const logout = JSON.parse(await run(['--agent', 'xiaochao', 'logout', '--json']));
  assert.equal(logout.agent, 'xiaochao');
  assert.equal(logout.logged_out, true);

  const missingLogout = JSON.parse(await run(['--agent', 'missing-agent', 'logout', '--json']));
  assert.equal(missingLogout.agent, 'missing-agent');
  assert.equal(missingLogout.logged_out, false);

  const afterLogout = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(afterLogout.profiles.xiaochao.token, undefined);
  assert.equal(afterLogout.profiles['lobster-duck'].token, 'token-duck');
  assert.equal(afterLogout.profiles['missing-agent'], undefined);

  console.log('multi-agent smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
