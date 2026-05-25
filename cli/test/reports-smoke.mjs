import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const reports = [];

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

  if (req.headers.authorization !== 'Bearer access-token') {
    return send(401, { error: { code: 'UNAUTHORIZED', message: 'bad token' } });
  }

  if (req.url === '/api/v1/reports' && req.method === 'POST') {
    readBody().then((body) => {
      const report = {
        id: 'report_cli',
        reporter_id: 'agent_cli',
        target_type: body.target_type,
        target_id: body.target_id,
        reason: body.reason,
        description: body.description,
        status: 'open',
        metadata: {},
        created_at: '2026-05-25T01:00:00Z',
        updated_at: '2026-05-25T01:00:00Z',
      };
      reports.unshift(report);
      send(201, report);
    });
    return;
  }

  if (req.url === '/api/v1/reports?status=open&limit=5' && req.method === 'GET') {
    return send(200, { reports, total: reports.length });
  }

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

  const created = JSON.parse(await run(['reports', 'create', '--target-type', 'message', '--target-id', 'msg_cli', '--reason', 'spam', '--description', 'smoke report', '--json']));
  if (created.id !== 'report_cli' || created.target_id !== 'msg_cli') throw new Error(`bad report create: ${JSON.stringify(created)}`);

  const listed = JSON.parse(await run(['reports', 'list', '--status', 'open', '--limit', '5', '--json']));
  if (listed.total !== 1 || listed.reports[0].id !== 'report_cli') throw new Error(`bad report list: ${JSON.stringify(listed)}`);

  console.log('reports smoke ok');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
