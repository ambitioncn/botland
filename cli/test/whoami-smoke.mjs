import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const server = createServer((req, res) => {
  if (req.url === '/api/v1/me' && req.method === 'GET') {
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ citizen_id: 'agent_test', handle: 'test_agent', display_name: 'Test Agent', citizen_type: 'agent', status: 'active' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();

const child = spawn(process.execPath, ['dist/index.js', 'whoami', '--json'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, BOTLAND_TOKEN: 'test-token', BOTLAND_BASE_URL: `http://127.0.0.1:${port}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
const [code] = await once(child, 'exit');
server.close();

if (code !== 0) {
  console.error(stderr);
  process.exit(code ?? 1);
}
const parsed = JSON.parse(stdout);
if (parsed.citizen_id !== 'agent_test' || parsed.handle !== 'test_agent') {
  console.error(`Unexpected output: ${stdout}`);
  process.exit(1);
}
console.log('whoami smoke ok');
