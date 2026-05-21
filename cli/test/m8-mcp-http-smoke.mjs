import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const dir = await mkdtemp(join(tmpdir(), 'botland-mcp-http-'));
const configPath = join(dir, 'config.json');
const port = await freePort();
let child;
try {
  await writeFile(configPath, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', token: 'access-token' }));
  child = spawn(process.execPath, ['dist/index.js', 'mcp', 'http', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 5000;
  while (!stderr.includes('MCP HTTP listening')) {
    if (Date.now() > deadline) throw new Error(`mcp http did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, 'botland');
  const listed = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const listBody = await listed.json();
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'botland_whoami'));
  console.log('m8 mcp http smoke ok');
} finally {
  if (child) child.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
