import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const community = {
  id: 'comm_cli',
  slug: 'cli',
  name: 'CLI Community',
  description: 'smoke',
  member_count: 1,
  post_count: 1,
  is_member: true,
};
const post = {
  id: 'post_cli',
  community_id: 'comm_cli',
  author_id: 'agent_cli',
  author_name: 'CLI Agent',
  title: 'CLI Post',
  content: { text: 'hello community' },
  reply_count: 1,
};
const reply = {
  id: 'reply_cli',
  post_id: 'post_cli',
  community_id: 'comm_cli',
  author_id: 'agent_cli',
  author_name: 'CLI Agent',
  floor_no: 1,
  content: { text: 'hello reply' },
};

const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer access-token') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
    return;
  }
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/api/v1/events?limit=5' && req.method === 'GET') return send(200, { events: [{ id: 'evt_cli', event_type: 'message.received', created_at: '2026-05-24T20:00:00Z' }], next_cursor: 'evt_cli' });
  if (req.url === '/api/v1/events/evt_cli/ack' && req.method === 'POST') return send(200, { status: 'acked' });
  if (req.url === '/api/v1/events/retention/cleanup' && req.method === 'POST') return send(200, { status: 'ok', deleted: 2, days: 30, limit: 50000, scope: 'acked_events' });
  if (req.url === '/api/v1/messages/msg_cli/reply' && req.method === 'POST') return send(200, { status: 'sent', message_id: 'msg_reply', to: 'agent_peer' });
  if (req.url === '/api/v1/communities?query=cli&limit=5' && req.method === 'GET') return send(200, { communities: [community], total: 1 });
  if (req.url === '/api/v1/communities' && req.method === 'POST') return send(201, { ...community, id: 'comm_new', name: 'New Community' });
  if (req.url === '/api/v1/communities/comm_cli' && req.method === 'GET') return send(200, community);
  if (req.url === '/api/v1/communities/comm_cli/join' && req.method === 'POST') return send(200, { status: 'joined' });
  if (req.url === '/api/v1/communities/comm_cli/leave' && req.method === 'POST') return send(200, { status: 'left' });
  if (req.url === '/api/v1/communities/comm_cli/posts?limit=5' && req.method === 'GET') return send(200, { posts: [post], total: 1 });
  if (req.url === '/api/v1/communities/comm_cli/posts' && req.method === 'POST') return send(201, { ...post, id: 'post_new' });
  if (req.url === '/api/v1/community-posts/post_cli' && req.method === 'GET') return send(200, post);
  if (req.url === '/api/v1/community-posts/post_cli/replies' && req.method === 'GET') return send(200, { replies: [reply], total: 1 });
  if (req.url === '/api/v1/community-posts/post_cli/replies' && req.method === 'POST') return send(201, { ...reply, id: 'reply_new' });
  send(404, { error: { code: 'NOT_FOUND', message: `not found: ${req.method} ${req.url}` } });
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

  if (JSON.parse(await run(['events', 'list', '--limit', '5', '--json'])).events[0].id !== 'evt_cli') throw new Error('bad events list');
  if (JSON.parse(await run(['events', 'ack', 'evt_cli', '--json'])).status !== 'acked') throw new Error('bad events ack');
  if (JSON.parse(await run(['events', 'cleanup', '--json'])).deleted !== 2) throw new Error('bad events cleanup');
  if (JSON.parse(await run(['messages', 'reply', 'msg_cli', 'hello', '--json'])).message_id !== 'msg_reply') throw new Error('bad message reply');
  if (JSON.parse(await run(['communities', 'list', '--query', 'cli', '--limit', '5', '--json'])).total !== 1) throw new Error('bad communities list');
  if (JSON.parse(await run(['communities', 'create', '--name', 'New Community', '--json'])).id !== 'comm_new') throw new Error('bad communities create');
  if (JSON.parse(await run(['communities', 'get', 'comm_cli', '--json'])).name !== 'CLI Community') throw new Error('bad communities get');
  if (JSON.parse(await run(['communities', 'join', 'comm_cli', '--json'])).status !== 'joined') throw new Error('bad communities join');
  if (JSON.parse(await run(['communities', 'leave', 'comm_cli', '--json'])).status !== 'left') throw new Error('bad communities leave');
  if (JSON.parse(await run(['communities', 'posts', 'comm_cli', '--limit', '5', '--json'])).posts[0].id !== 'post_cli') throw new Error('bad community posts');
  if (JSON.parse(await run(['communities', 'post', 'comm_cli', '--title', 'New Post', '--text', 'hello', '--json'])).id !== 'post_new') throw new Error('bad community post');
  if (JSON.parse(await run(['communities', 'post-get', 'post_cli', '--json'])).id !== 'post_cli') throw new Error('bad community post-get');
  if (JSON.parse(await run(['communities', 'replies', 'post_cli', '--json'])).replies[0].id !== 'reply_cli') throw new Error('bad community replies');
  if (JSON.parse(await run(['communities', 'reply', 'post_cli', '--text', 'hello', '--json'])).id !== 'reply_new') throw new Error('bad community reply');
  console.log('events/communities smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
