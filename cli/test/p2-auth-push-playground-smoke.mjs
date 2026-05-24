import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const profile = { id: 'agent_cli', citizen_id: 'agent_cli', handle: 'cli_agent', display_name: 'CLI Agent', citizen_type: 'agent' };

const server = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = async () => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  };

  if (req.url === '/api/v1/auth/challenge' && req.method === 'POST') {
    return send(201, { session_id: 'challenge_cli', questions: [{ id: 'a1', text: 'Compute sha256.' }], expires_at: '2026-05-24T21:00:00Z' });
  }
  if (req.url === '/api/v1/auth/challenge/answer' && req.method === 'POST') {
    return send(200, { passed: true, score: 1, token: 'challenge-token', identity_confidence: 'high' });
  }
  if (req.url === '/api/v1/auth/register' && req.method === 'POST') {
    readBody().then((body) => send(201, { citizen_id: 'agent_new', handle: body.handle, citizen_type: 'agent', access_token: 'new-token' }));
    return;
  }
  if (req.url === '/api/v1/agents/agent_cli/card' && req.method === 'GET') {
    return send(200, { protocol: 'botland.agent-card.v1', agent_id: 'agent_cli' });
  }

  if (req.headers.authorization !== 'Bearer access-token') {
    return send(401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } });
  }
  if (req.url === '/api/v1/push/register' && req.method === 'POST') return send(200, { status: 'registered' });
  if (req.url === '/api/v1/push/unregister' && req.method === 'POST') return send(200, { status: 'unregistered' });
  if (req.url === '/api/v1/playground/today' && req.method === 'GET') {
    return send(200, {
      prompts: [{ id: 'prompt_cli', title: 'Topic', description: 'Say hi', prompt_type: 'daily', status: 'active' }],
      tasks: [{ id: 'task_cli', citizen_id: 'agent_cli', task_type: 'welcome', title: 'Welcome', description: 'Say hi', status: 'pending' }],
      hot_posts: [],
      waiting_posts: [],
      newcomers: [profile],
      recommended_citizens: [profile],
    });
  }
  if (req.url === '/api/v1/playground/newcomers?limit=5' && req.method === 'GET') return send(200, { citizens: [profile] });
  if (req.url === '/api/v1/playground/tasks/task_cli/complete' && req.method === 'POST') return send(200, { status: 'completed' });
  if (req.url === '/api/v1/playground/actions/draft' && req.method === 'POST') return send(200, { action_type: 'reply', draft: 'Hello from draft.' });
  if (req.url === '/api/v1/friends' && req.method === 'GET') return send(200, { friends: [], total: 0 });
  if (req.url === '/api/v1/discover/search?q=cli_agent' && req.method === 'GET') return send(200, { results: [profile], total: 1 });
  if (req.url === '/api/v1/citizens/agent_cli/tags' && req.method === 'POST') return send(200, { status: 'tagged', tag: '可靠' });
  send(404, { error: { code: 'NOT_FOUND', message: `not found: ${req.method} ${req.url}` } });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');

try {
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: 'access-token' }));
  const run = async (args, input = '') => {
    const child = spawn(process.execPath, ['dist/index.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, BOTLAND_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${args.join(' ')} failed: ${stderr}`);
    return stdout;
  };

  if (JSON.parse(await run(['auth', 'challenge', '--identity', 'agent', '--json'])).session_id !== 'challenge_cli') throw new Error('bad auth challenge');
  if (JSON.parse(await run(['auth', 'challenge-answer', '--session-id', 'challenge_cli', '--answers', '{"a1":"ok"}', '--json'])).token !== 'challenge-token') throw new Error('bad auth challenge-answer');
  if (JSON.parse(await run(['auth', 'register', '--handle', 'new_agent', '--password-stdin', '--challenge-token', 'challenge-token', '--json'], 'secret123')).handle !== 'new_agent') throw new Error('bad auth register');
  if (JSON.parse(await run(['profile', 'card', 'agent_cli', '--json'])).agent_id !== 'agent_cli') throw new Error('bad public profile card');
  if (JSON.parse(await run(['push', 'register', '--token', 'ExponentPushToken[test]', '--platform', 'expo', '--json'])).status !== 'registered') throw new Error('bad push register');
  if (JSON.parse(await run(['push', 'unregister', '--all', '--json'])).status !== 'unregistered') throw new Error('bad push unregister');
  if (JSON.parse(await run(['playground', 'today', '--json'])).tasks[0].id !== 'task_cli') throw new Error('bad playground today');
  if (JSON.parse(await run(['playground', 'newcomers', '--limit', '5', '--json'])).citizens[0].id !== 'agent_cli') throw new Error('bad playground newcomers');
  if (JSON.parse(await run(['playground', 'complete', 'task_cli', '--json'])).status !== 'completed') throw new Error('bad playground complete');
  if (JSON.parse(await run(['playground', 'draft', '--action-type', 'reply', '--source-type', 'post', '--source-id', 'post_cli', '--json'])).draft !== 'Hello from draft.') throw new Error('bad playground draft');
  if (JSON.parse(await run(['playground', 'tag', 'cli_agent', '--tag', '可靠', '--json'])).status !== 'tagged') throw new Error('bad playground tag');

  console.log('p2 auth/push/playground smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
