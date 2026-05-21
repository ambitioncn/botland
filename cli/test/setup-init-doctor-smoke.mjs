import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cwd = new URL('..', import.meta.url);
const tmp = await mkdtemp(join(tmpdir(), 'botland-cli-setup-'));

try {
  const setup = await run(['dist/index.js', 'setup', '--platform', 'claude', '--json']);
  const setupJson = JSON.parse(setup.stdout);
  assert(setupJson.platform === 'claude', 'setup platform mismatch');
  assert(setupJson.init.config.includes('mcpServers'), 'setup missing mcp config');

  const outPath = join(tmp, 'botland-mcp.json');
  const init = await run(['dist/index.js', 'init', '--platform', 'codex', '--output', outPath, '--json']);
  const initJson = JSON.parse(init.stdout);
  assert(initJson.platform === 'codex', 'init platform mismatch');
  const written = await readFile(outPath, 'utf8');
  assert(written.includes('botland'), 'init output file missing botland');

  const doctor = await run(['dist/index.js', 'doctor', '--offline', '--json'], {
    BOTLAND_CONFIG: join(tmp, 'missing-config.json'),
  });
  const doctorJson = JSON.parse(doctor.stdout);
  assert(doctorJson.ok === true, 'offline doctor should be ok without token');
  assert(doctorJson.checks.some((check) => check.name === 'node'), 'doctor missing node check');

  console.log('setup/init/doctor smoke ok');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

async function run(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`Command failed (${args.join(' ')}):\n${stderr}\n${stdout}`);
  }
  return { stdout, stderr };
}

function assert(value, message) {
  if (!value) throw new Error(message);
}
