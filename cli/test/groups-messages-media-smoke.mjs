import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const group = {
  id: 'group_cli',
  name: 'CLI Group',
  description: 'smoke',
  member_count: 2,
  members: [{ citizen_id: 'agent_cli', display_name: 'CLI Agent', role: 'owner' }],
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
  if (req.url === '/api/v1/groups' && req.method === 'GET') return send(200, [group]);
  if (req.url === '/api/v1/groups' && req.method === 'POST') return send(201, { id: 'group_new', name: 'New Group' });
  if (req.url === '/api/v1/groups/group_cli' && req.method === 'GET') return send(200, group);
  if (req.url === '/api/v1/groups/group_cli' && req.method === 'PUT') return send(200, { status: 'updated' });
  if (req.url === '/api/v1/groups/group_cli/members' && req.method === 'POST') return send(200, { status: 'invited', invited: 1 });
  if (req.url === '/api/v1/groups/group_cli/members/agent_member' && req.method === 'DELETE') return send(200, { status: 'removed' });
  if (req.url === '/api/v1/groups/group_cli/members/agent_member/role' && req.method === 'PUT') return send(200, { status: 'updated' });
  if (req.url === '/api/v1/groups/group_cli/leave' && req.method === 'POST') return send(200, { status: 'left' });
  if (req.url === '/api/v1/groups/group_cli' && req.method === 'DELETE') return send(200, { status: 'disbanded' });
  if (req.url === '/api/v1/groups/group_cli/transfer' && req.method === 'POST') return send(200, { status: 'transferred' });
  if (req.url === '/api/v1/groups/group_cli/mute-all' && req.method === 'POST') return send(200, { status: 'muted' });
  if (req.url === '/api/v1/groups/group_cli/messages?limit=5' && req.method === 'GET') {
    return send(200, [{ id: 'gmsg_1', group_id: 'group_cli', sender_id: 'agent_cli', sender_name: 'CLI Agent', payload: { text: 'hello group' }, created_at: '2026-05-24T19:00:00Z' }]);
  }
  if (req.url === '/api/v1/messages/search?q=hello&limit=5' && req.method === 'GET') {
    return send(200, { query: 'hello', total: 1, results: [{ id: 'msg_1', chat_id: 'group_cli', chat_type: 'group', from_id: 'agent_cli', from_name: 'CLI Agent', text: 'hello group', timestamp: '2026-05-24T19:00:00Z', peer_name: 'CLI Group' }] });
  }
  if (req.url === '/api/v1/media/upload?category=chat' && req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data;')) return send(400, { error: { code: 'BAD_CONTENT_TYPE', message: 'expected multipart' } });
    req.resume();
    return req.on('end', () => send(201, { url: 'http://example.test/uploads/chat/file.png', filename: 'file.png', size: 4, content_type: 'image/png', media_type: 'image' }));
  }
  send(404, { error: { code: 'NOT_FOUND', message: `not found: ${req.method} ${req.url}` } });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();
const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');
const filePath = join(dir, 'file.png');

try {
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: 'access-token' }));
  await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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

  if (JSON.parse(await run(['groups', 'list', '--json']))[0].id !== 'group_cli') throw new Error('bad groups list');
  if (JSON.parse(await run(['groups', 'create', '--name', 'New Group', '--members', 'agent_member', '--json'])).id !== 'group_new') throw new Error('bad groups create');
  if (JSON.parse(await run(['groups', 'get', 'group_cli', '--json'])).member_count !== 2) throw new Error('bad groups get');
  if (JSON.parse(await run(['groups', 'update', 'group_cli', '--announcement', 'news', '--json'])).status !== 'updated') throw new Error('bad groups update');
  if (JSON.parse(await run(['groups', 'invite', 'group_cli', '--members', 'agent_member', '--json'])).status !== 'invited') throw new Error('bad groups invite');
  if (JSON.parse(await run(['groups', 'remove', 'group_cli', '--citizen-id', 'agent_member', '--json'])).status !== 'removed') throw new Error('bad groups remove');
  if (JSON.parse(await run(['groups', 'role', 'group_cli', '--citizen-id', 'agent_member', '--role', 'admin', '--json'])).status !== 'updated') throw new Error('bad groups role');
  if (JSON.parse(await run(['groups', 'leave', 'group_cli', '--json'])).status !== 'left') throw new Error('bad groups leave');
  if (JSON.parse(await run(['groups', 'disband', 'group_cli', '--json'])).status !== 'disbanded') throw new Error('bad groups disband');
  if (JSON.parse(await run(['groups', 'transfer', 'group_cli', '--citizen-id', 'agent_member', '--json'])).status !== 'transferred') throw new Error('bad groups transfer');
  if (JSON.parse(await run(['groups', 'mute', 'group_cli', '--unmuted', '--json'])).status !== 'muted') throw new Error('bad groups mute');
  if (JSON.parse(await run(['groups', 'messages', 'group_cli', '--limit', '5', '--json']))[0].id !== 'gmsg_1') throw new Error('bad group messages');
  if (JSON.parse(await run(['messages', 'search', 'hello', '--limit', '5', '--json'])).total !== 1) throw new Error('bad messages search');
  if (JSON.parse(await run(['media', 'upload', '--file', filePath, '--category', 'chat', '--json'])).media_type !== 'image') throw new Error('bad media upload');

  console.log('groups/messages/media smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
