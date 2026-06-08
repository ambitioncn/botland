import { spawnSync } from 'node:child_process';
import { BOTLAND_CONTRACT_VERSION, BOTLAND_INTENTS, normalizeDaemonHealth, normalizeIdentity } from './contract.mjs';
import { commandEnv, runBotlandIntent } from './cli-driver.mjs';

export const MIN_CLI_VERSION = '0.1.0-alpha.10';

export function parseVersion(text) {
  const match = String(text ?? '').match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

export function versionTooLow(actual, minimum = MIN_CLI_VERSION) {
  if (!actual) return true;
  const normalize = (version) => {
    const [main, pre = ''] = version.split('-', 2);
    return {
      numbers: main.split('.').map((part) => Number.parseInt(part, 10)),
      pre
    };
  };
  const left = normalize(actual);
  const right = normalize(minimum);
  for (let i = 0; i < 3; i += 1) {
    const a = Number.isInteger(left.numbers[i]) ? left.numbers[i] : 0;
    const b = Number.isInteger(right.numbers[i]) ? right.numbers[i] : 0;
    if (a !== b) return a < b;
  }
  if (left.pre === right.pre) return false;
  if (!left.pre) return false;
  if (!right.pre) return true;
  return left.pre.localeCompare(right.pre) < 0;
}

function runHealthCurl(healthUrl, timeoutMs = 8000) {
  const result = spawnSync('curl', ['-fsS', '--max-time', '5', healthUrl], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: commandEnv()
  });
  const stdout = result.stdout ? result.stdout.trim() : '';
  const stderr = result.stderr ? result.stderr.trim() : '';
  let json = null;
  if (stdout) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }
  return {
    command: `curl -fsS --max-time 5 ${healthUrl}`,
    ok: result.status === 0 && !result.error,
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout_json: json,
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function sleepSeconds(seconds) {
  spawnSync('sleep', [String(seconds)], { encoding: 'utf8', env: commandEnv() });
}

function runBotlandIntentWithRetry(intent, params = {}, options = {}) {
  const attempts = options.attempts ?? 3;
  const delaySeconds = options.delaySeconds ?? 1;
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResult = runBotlandIntent(intent, params, options);
    if (lastResult.ok === true) {
      return { ...lastResult, attempt_count: attempt };
    }
    if (attempt < attempts) sleepSeconds(delaySeconds);
  }
  return { ...lastResult, attempt_count: attempts };
}

export function probeBotlandCapabilities({ healthUrl = 'http://127.0.0.1:3100/health', agent = null } = {}) {
  const version = runBotlandIntent(BOTLAND_INTENTS.CLI_VERSION, {}, { timeoutMs: 10000 });
  const cliVersion = parseVersion(version.stdout_preview || version.stderr_preview);
  const whoami = runBotlandIntentWithRetry(BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000, agent });
  const health = runHealthCurl(healthUrl);
  const normalizedIdentity = normalizeIdentity(whoami.stdout_json);
  const normalizedHealth = normalizeDaemonHealth(health.stdout_json);

  return {
    contract_version: BOTLAND_CONTRACT_VERSION,
    driver: 'cli',
    agent_profile: agent,
    generated_at: new Date().toISOString(),
    minimum_cli_version: MIN_CLI_VERSION,
    cli_version: cliVersion,
    cli_version_ok: version.ok && !versionTooLow(cliVersion),
    identity: normalizedIdentity,
    daemon_health: normalizedHealth,
    health_url: healthUrl,
    commands: {
      version: {
        ok: version.ok,
        command: version.command,
        status: version.status,
        stderr_preview: version.stderr_preview
      },
      whoami: {
        ok: whoami.ok,
        command: whoami.command,
        status: whoami.status,
        attempt_count: whoami.attempt_count,
        stderr_preview: whoami.stderr_preview
      },
      daemon_health: {
        ok: health.ok,
        command: health.command,
        status: health.status,
        stderr_preview: health.stderr_preview
      }
    },
    capabilities: {
      read_identity: whoami.ok,
      daemon_health: health.ok,
      websocket_presence: Array.isArray(normalizedHealth.raw_shape)
        && (normalizedHealth.raw_shape.includes('websocket_connected')
          || normalizedHealth.raw_shape.includes('websocketConnected')
          || normalizedHealth.raw_shape.includes('websocket')),
      read_events: true,
      read_friends: true,
      read_moments: true,
      read_communities: true,
      draft_safe_writes: false,
      external_writes_require_tool_supervision: true
    }
  };
}
