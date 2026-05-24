import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const webhooks = new Map();

const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer access-token') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
    return;
  }

  if (req.url === '/api/v1/webhooks' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const item = { id: 'wh_test', url: parsed.url, events: parsed.events, enabled: true, secret: 'secret_test' };
      webhooks.set(item.id, item);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
    });
    return;
  }

  if (req.url === '/api/v1/webhooks' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ webhooks: [...webhooks.values()].map(({ secret, ...item }) => item), total: webhooks.size }));
    return;
  }

  if (req.url === '/api/v1/webhooks/wh_test/test' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', attempts: 1, response_status: 200 }));
    return;
  }

  if (req.url === '/api/v1/webhooks/wh_test/rotate-secret' && req.method === 'POST') {
    const item = webhooks.get('wh_test');
    if (item) item.secret = 'secret_rotated';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'wh_test', secret: 'secret_rotated', rotated: true }));
    return;
  }

  if (req.url === '/api/v1/webhooks/wh_test' && req.method === 'PATCH') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const item = webhooks.get('wh_test');
      Object.assign(item, JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'updated' }));
    });
    return;
  }

  if (req.url === '/api/v1/webhooks/deliveries/retention/cleanup' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', deleted: 3, days: 30, limit: 50000, scope: 'terminal_webhook_deliveries' }));
    return;
  }

  if (req.url === '/api/v1/webhooks/wh_test' && req.method === 'DELETE') {
    webhooks.delete('wh_test');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'deleted' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
});

async function run(args, configPath) {
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
}

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');

try {
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: 'access-token' }));
  const created = JSON.parse(await run(['webhooks', 'create', '--url', 'https://example.com/botland', '--events', 'message.received,friend.request', '--json'], configPath));
  if (created.id !== 'wh_test' || created.secret !== 'secret_test') throw new Error('bad create output');
  const listed = JSON.parse(await run(['webhooks', 'list', '--json'], configPath));
  if (listed.total !== 1 || listed.webhooks[0].events[1] !== 'friend.request') throw new Error('bad list output');
  const tested = JSON.parse(await run(['webhooks', 'test', 'wh_test', '--json'], configPath));
  if (tested.status !== 'success') throw new Error('bad test output');
  const rotated = JSON.parse(await run(['webhooks', 'rotate-secret', 'wh_test', '--json'], configPath));
  if (!rotated.rotated || rotated.secret !== 'secret_rotated') throw new Error('bad rotate output');
  const patched = JSON.parse(await run(['webhooks', 'patch', 'wh_test', '--disable', '--json'], configPath));
  if (patched.status !== 'updated' || webhooks.get('wh_test').enabled !== false) throw new Error('bad patch output');
  const enabled = JSON.parse(await run(['webhooks', 'enable', 'wh_test', '--json'], configPath));
  if (enabled.status !== 'updated' || webhooks.get('wh_test').enabled !== true) throw new Error('bad enable output');
  const cleaned = JSON.parse(await run(['webhooks', 'cleanup-deliveries', '--json'], configPath));
  if (cleaned.deleted !== 3 || cleaned.scope !== 'terminal_webhook_deliveries') throw new Error('bad cleanup output');
  const deleted = JSON.parse(await run(['webhooks', 'delete', 'wh_test', '--json'], configPath));
  if (deleted.status !== 'deleted') throw new Error('bad delete output');
  console.log('webhooks smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
