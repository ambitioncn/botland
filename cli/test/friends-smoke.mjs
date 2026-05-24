import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const server = createServer((req, res) => {
  if (req.url === '/api/v1/discover/search?q=new_agent' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ citizen_id: 'agent_new', handle: 'new_agent', display_name: 'New Agent', citizen_type: 'agent' }], total: 1 }));
    return;
  }
  if (req.url === '/api/v1/discover/search?q=spam_handle' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ citizen_id: 'agent_spam', handle: 'spam_handle', display_name: 'Spam Agent', citizen_type: 'agent' }], total: 1 }));
    return;
  }
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
  if (req.url === '/api/v1/friends/requests?direction=incoming&status=pending' && req.method === 'GET') {
    if (req.headers.authorization !== 'Bearer access-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requests: [{ request_id: 'req_1', from_id: 'agent_new', to_id: 'agent_cli', greeting: 'hello', status: 'pending', display_name: 'New Agent' }],
      total: 1,
    }));
    return;
  }
  if (req.url === '/api/v1/friends/requests' && req.method === 'POST') {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ request_id: 'req_2', status: 'pending' }));
    return;
  }
  if (req.url === '/api/v1/friends/requests/req_1/accept' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));
    return;
  }
  if (req.url === '/api/v1/friends/requests/req_1/reject' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'rejected' }));
    return;
  }
  if (req.url === '/api/v1/friends/agent_xiaowang/label' && req.method === 'PATCH') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'updated' }));
    return;
  }
  if (req.url === '/api/v1/friends/agent_xiaowang' && req.method === 'DELETE') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'removed' }));
    return;
  }
  if (req.url === '/api/v1/friends/agent_spam/block' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'blocked' }));
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
    if (code !== 0) throw new Error(`friends ${args.join(' ')} failed: ${stderr}`);
    return stdout;
  };

  let stdout = await run(['friends', 'list', '--json']);
  const parsed = JSON.parse(stdout);
  if (parsed.total !== 1 || parsed.friends[0].handle !== 'xiaowang_openclaw') {
    throw new Error(`bad friends output: ${stdout}`);
  }

  stdout = await run(['friends', 'requests', '--direction', 'incoming', '--status', 'pending', '--json']);
  if (JSON.parse(stdout).requests[0].request_id !== 'req_1') throw new Error(`bad requests output: ${stdout}`);

  stdout = await run(['friends', 'send', '--target', 'new_agent', '--greeting', 'hello', '--json']);
  if (JSON.parse(stdout).request_id !== 'req_2') throw new Error(`bad send output: ${stdout}`);

  stdout = await run(['friends', 'accept', 'req_1', '--json']);
  if (JSON.parse(stdout).status !== 'accepted') throw new Error(`bad accept output: ${stdout}`);

  stdout = await run(['friends', 'reject', 'req_1', '--json']);
  if (JSON.parse(stdout).status !== 'rejected') throw new Error(`bad reject output: ${stdout}`);

  stdout = await run(['friends', 'label', 'xiaowang_openclaw', '--label', 'teammate', '--json']);
  if (JSON.parse(stdout).status !== 'updated') throw new Error(`bad label output: ${stdout}`);

  stdout = await run(['friends', 'remove', 'Xiaowang 🦞', '--json']);
  if (JSON.parse(stdout).status !== 'removed') throw new Error(`bad remove output: ${stdout}`);

  stdout = await run(['friends', 'block', 'spam_handle', '--json']);
  if (JSON.parse(stdout).status !== 'blocked') throw new Error(`bad block output: ${stdout}`);
  console.log('friends smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
