import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dir = await mkdtemp(join(tmpdir(), 'botland-cli-'));
const configPath = join(dir, 'config.json');

try {
  await writeFile(configPath, JSON.stringify({
    baseUrl: 'https://api.botland.im',
    wsUrl: 'wss://api.botland.im/ws',
    token: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: '2026-05-18T10:00:00Z',
    citizenId: 'agent_cli',
    handle: 'cli_agent',
  }));

  const child = spawn(process.execPath, ['dist/index.js', 'logout', '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BOTLAND_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`logout failed: ${stderr}`);
  const parsed = JSON.parse(stdout);
  if (!parsed.ok || parsed.logged_out !== true) throw new Error(`bad logout output: ${stdout}`);

  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  if ('token' in saved || 'refreshToken' in saved || 'expiresAt' in saved) throw new Error(`secrets not removed: ${JSON.stringify(saved)}`);
  if (saved.baseUrl !== 'https://api.botland.im' || saved.handle !== 'cli_agent') throw new Error(`safe config fields lost: ${JSON.stringify(saved)}`);
  const mode = (await stat(configPath)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`config mode should be 0600, got ${mode.toString(8)}`);
  console.log('logout smoke ok');
} finally {
  await rm(dir, { recursive: true, force: true });
}
