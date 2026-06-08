#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const CONFIRM_WRITE = 'WRITE_AGENT_BOTLAND_AUTH_CONFIG';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    format: 'text',
    timeoutMs: 10000,
    writeArtifact: true,
    botlandConfig: null,
    tokenEnv: null,
    confirmWrite: null,
    force: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--botland-config') args.botlandConfig = path.resolve(argv[++i]);
    else if (arg === '--token-env') args.tokenEnv = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number.parseInt(argv[++i], 10);
    else if (arg === '--confirm-write') args.confirmWrite = argv[++i];
    else if (arg === '--force') args.force = true;
    else if (arg === '--no-write-artifact') args.writeArtifact = false;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error('--timeout-ms must be an integer >= 1000');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/botland-agent-auth-configure.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --botland-config <file>  BotLand config.json to update with a named profile.
  --token-env <name>       Environment variable containing the agent token.
  --confirm-write <token>  Required token: ${CONFIRM_WRITE}
  --force                  Overwrite an existing target config after identity match.
  --timeout-ms <n>         Per-command timeout in ms. Default: 10000
  --no-write-artifact      Print only; do not write runtime evidence.
  --json                   Print JSON.
  --help                   Show this help.

This command never accepts a token on the command line and never records token
values. It reads the token only from the named environment variable, verifies
botland --agent <id> whoami matches life_state.botland.citizen_id, and only
then writes profiles.<agent> in config.json when the explicit confirmation
token is supplied.
`);
}

function nowStamp(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sanitizeEnvSuffix(agent) {
  return String(agent)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'AGENT';
}

function defaultConfigPath(agent) {
  void agent;
  return path.join(os.homedir(), '.config', 'botland', 'config.json');
}

function defaultBaseUrl() {
  return (process.env.BOTLAND_BASE_URL || 'https://api.botland.im').replace(/\/+$/, '');
}

function deriveWsUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function commandEnv(auth) {
  const pathPrefix = path.join(os.homedir(), '.npm-global', 'bin');
  return {
    ...process.env,
    PATH: `${pathPrefix}:${process.env.PATH ?? ''}`,
    BOTLAND_CONFIG: auth.configPath,
    BOTLAND_AGENT: auth.agent,
    BOTLAND_TOKEN: '',
    BOTLAND_BASE_URL: auth.baseUrl,
    BOTLAND_WS_URL: auth.wsUrl
  };
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runBotland(args, auth, timeoutMs) {
  const commandArgs = auth.agent ? ['--agent', auth.agent, ...args] : args;
  const result = spawnSync('botland', commandArgs, {
    cwd: WORKSPACE,
    env: commandEnv(auth),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  return {
    command: ['botland', ...commandArgs].join(' '),
    ok: result.status === 0 && !result.error,
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout_json: parseJson(stdout),
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function summarizeWhoami(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    citizen_id: profile.citizen_id ?? profile.citizenId ?? profile.id ?? null,
    display_name: profile.display_name ?? profile.displayName ?? profile.name ?? null,
    handle: profile.handle ?? null,
    citizen_type: profile.citizen_type ?? profile.citizenType ?? null
  };
}

function issue(level, code, message) {
  return { level, code, message };
}

function writeConfigAtomic(file, payload) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function readConfig(file) {
  if (!existsSync(file)) return {};
  return readJson(file);
}

function buildReport(args) {
  const issues = [];
  const runtimeDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(runtimeDir, 'life_state.json');
  let lifeState = null;
  if (!existsSync(lifeStatePath)) {
    issues.push(issue('error', 'life_state_missing', `Missing life_state.json: ${lifeStatePath}`));
  } else {
    try {
      lifeState = readJson(lifeStatePath);
    } catch (error) {
      issues.push(issue('error', 'life_state_invalid_json', error instanceof Error ? error.message : String(error)));
    }
  }

  const expectedCitizenId = lifeState?.botland?.citizen_id ?? null;
  const expectedDisplayName = lifeState?.botland?.display_name ?? lifeState?.self_model?.name ?? null;
  if (!expectedCitizenId) {
    issues.push(issue('error', 'expected_citizen_id_missing', 'life_state.botland.citizen_id is required'));
  }

  const auth = {
    agent: args.agent,
    configPath: args.botlandConfig ?? defaultConfigPath(args.agent),
    tokenEnvName: args.tokenEnv ?? `BOTLAND_TOKEN_${sanitizeEnvSuffix(args.agent)}`,
    baseUrl: defaultBaseUrl(),
    wsUrl: (process.env.BOTLAND_WS_URL || deriveWsUrl(defaultBaseUrl())).replace(/\/+$/, '')
  };
  const tokenEnvSet = Boolean(process.env[auth.tokenEnvName]);
  const targetConfigExists = existsSync(auth.configPath);
  let profileExistsBefore = false;
  if (targetConfigExists) {
    try {
      const currentConfig = readConfig(auth.configPath);
      profileExistsBefore = Boolean(currentConfig?.profiles?.[args.agent]);
    } catch (error) {
      issues.push(issue('error', 'botland_config_invalid_json', error instanceof Error ? error.message : String(error)));
    }
  }
  if (!tokenEnvSet) {
    issues.push(issue('error', 'agent_token_env_missing', `Missing agent token env ${auth.tokenEnvName}`));
  }
  if (profileExistsBefore && !args.force) {
    issues.push(issue('error', 'target_profile_exists', `Target named profile already exists; pass --force only after confirming it should be replaced: ${args.agent}`));
  }

  const cliVersion = runBotland(['--version'], { ...auth, agent: null }, args.timeoutMs);
  if (!cliVersion.ok) {
    issues.push(issue('error', 'botland_cli_unavailable', cliVersion.stderr_preview || cliVersion.error || 'botland --version failed'));
  }

  let whoami = null;
  let whoamiSummary = null;
  if (tokenEnvSet) {
    whoami = runBotland(['whoami', '--json'], auth, args.timeoutMs);
    whoamiSummary = summarizeWhoami(whoami.stdout_json);
    if (!whoami.ok) {
      issues.push(issue('error', 'agent_whoami_failed', whoami.stderr_preview || whoami.error || 'botland whoami failed for token env'));
    }
    if (whoami.ok && expectedCitizenId && whoamiSummary?.citizen_id !== expectedCitizenId) {
      issues.push(issue(
        'error',
        'agent_authenticated_identity_mismatch',
        `token env whoami ${whoamiSummary?.citizen_id ?? 'unknown'} does not match target ${expectedCitizenId}`
      ));
    }
  }

  const identityReady = Boolean(expectedCitizenId && whoamiSummary?.citizen_id === expectedCitizenId);
  const confirmMatches = args.confirmWrite === CONFIRM_WRITE;
  if (!confirmMatches) {
    issues.push(issue('warning', 'write_confirmation_missing', `Config write requires --confirm-write ${CONFIRM_WRITE}`));
  }

  let configWritten = false;
  let fileMode = null;
  const hardErrorCountBeforeWrite = issues.filter((item) => item.level === 'error').length;
  if (hardErrorCountBeforeWrite === 0 && identityReady && confirmMatches) {
    const currentConfig = readConfig(auth.configPath);
    writeConfigAtomic(auth.configPath, {
      ...currentConfig,
      activeAgent: args.agent,
      profiles: {
        ...(currentConfig.profiles ?? {}),
        [args.agent]: {
          baseUrl: auth.baseUrl,
          wsUrl: auth.wsUrl,
          token: process.env[auth.tokenEnvName],
          citizenId: expectedCitizenId,
          handle: whoamiSummary?.handle ?? undefined,
          citizenType: whoamiSummary?.citizen_type ?? undefined
        }
      }
    });
    configWritten = true;
    try {
      fileMode = `0${(readFileMode(auth.configPath) & 0o777).toString(8)}`;
    } catch {
      fileMode = null;
    }
  }

  const errorCount = issues.filter((item) => item.level === 'error').length;
  const warningCount = issues.filter((item) => item.level === 'warning').length;
  const report = {
    schema_version: 'stay_alive.botland_agent_auth_configure.v1',
    configure_id: `botland_agent_auth_configure_${nowStamp()}_${args.agent}`,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    expected: {
      citizen_id: expectedCitizenId,
      display_name: expectedDisplayName
    },
    auth_material: {
      config_path: auth.configPath,
      config_exists_before: targetConfigExists,
      profile_name: args.agent,
      profile_exists_before: profileExistsBefore,
      config_written: configWritten,
      config_mode_after: fileMode,
      token_env_name: auth.tokenEnvName,
      token_env_set: tokenEnvSet,
      token_value_recorded: false,
      token_accepted_from_cli_arg: false,
      ambient_default_may_be_used: false
    },
    cli: {
      ok: cliVersion.ok,
      version: cliVersion.stdout_preview || null
    },
    authenticated_identity: {
      attempted: Boolean(whoami),
      read_ok: whoami?.ok === true,
      matches_expected: identityReady,
      whoami: whoamiSummary
    },
    write_gate: {
      required_confirmation: CONFIRM_WRITE,
      confirmation_supplied: Boolean(args.confirmWrite),
      confirmation_matches: confirmMatches,
      force: args.force
    },
    external_write: false,
    botland_send: false,
    botland_post: false,
    botland_reply: false,
    botland_profile_update: false,
    botland_register: false,
    life_state_mutated: false,
    local_secret_config_write: configWritten,
    pass: configWritten && errorCount === 0,
    level: errorCount > 0 ? 'blocked' : configWritten ? 'ok' : 'review',
    error_count: errorCount,
    warning_count: warningCount,
    issues
  };

  if (args.writeArtifact && existsSync(runtimeDir)) {
    const dir = path.join(runtimeDir, 'botland_auth_configure');
    mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, `${report.configure_id}.json`);
    writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    report.artifact_path = path.relative(WORKSPACE, artifactPath);
  }

  return report;
}

function readFileMode(file) {
  return existsSync(file) ? statSync(file).mode : 0;
}

function printText(report) {
  console.log(`BotLand agent auth configure: ${report.agent_id}`);
  console.log(`- pass: ${report.pass}`);
  console.log(`- level: ${report.level}`);
  console.log(`- expected_citizen_id: ${report.expected.citizen_id ?? 'n/a'}`);
  console.log(`- token_env_set: ${report.auth_material.token_env_set}`);
  console.log(`- identity_match: ${report.authenticated_identity.matches_expected}`);
  console.log(`- config_written: ${report.auth_material.config_written}`);
  console.log(`- token_value_recorded: ${report.auth_material.token_value_recorded}`);
  if (report.artifact_path) console.log(`- artifact: ${report.artifact_path}`);
  if (report.issues.length > 0) {
    console.log('Issues:');
    for (const item of report.issues) {
      console.log(`- [${item.level}] ${item.code}: ${item.message}`);
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else printText(report);
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
