#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    format: 'text',
    timeoutMs: 10000,
    writeArtifact: true,
    botlandConfig: null,
    tokenEnv: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--botland-config') args.botlandConfig = path.resolve(argv[++i]);
    else if (arg === '--token-env') args.tokenEnv = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number.parseInt(argv[++i], 10);
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
  console.log(`Usage: node scripts/stay-alive/botland-agent-auth-readiness.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --botland-config <file>  BotLand config.json containing named profiles.
  --token-env <name>       Environment variable containing an agent token.
  --timeout-ms <n>         Per-command timeout in ms. Default: 10000
  --no-write-artifact      Print only; do not write runtime evidence.
  --json                   Print JSON.
  --help                   Show this help.

This command is read-only and secret-hygienic. It never prints token values and
does not use the ambient default BotLand identity. By default it looks for:
  ~/.config/botland/config.json profiles.<agent>
  BOTLAND_TOKEN_<AGENT_ID_SANITIZED>
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

function commandEnv(auth) {
  const pathPrefix = path.join(os.homedir(), '.npm-global', 'bin');
  const env = {
    ...process.env,
    PATH: `${pathPrefix}:${process.env.PATH ?? ''}`
  };
  if (auth.configPath) env.BOTLAND_CONFIG = auth.configPath;
  if (auth.agent) env.BOTLAND_AGENT = auth.agent;
  env.BOTLAND_TOKEN = '';
  return env;
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
  const command = ['botland', ...args];
  const result = spawnSync('botland', args, {
    cwd: WORKSPACE,
    env: commandEnv(auth),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  return {
    command: command.join(' '),
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
    tokenEnvName: args.tokenEnv ?? `BOTLAND_TOKEN_${sanitizeEnvSuffix(args.agent)}`
  };
  const configExists = Boolean(auth.configPath && existsSync(auth.configPath));
  let profileExists = false;
  let profileHasToken = false;
  if (configExists) {
    try {
      const config = readJson(auth.configPath);
      const profile = config?.profiles?.[args.agent];
      profileExists = Boolean(profile);
      profileHasToken = Boolean(profile?.token);
    } catch (error) {
      issues.push(issue('error', 'botland_config_invalid_json', error instanceof Error ? error.message : String(error)));
    }
  }
  const tokenEnvSet = Boolean(auth.tokenEnvName && process.env[auth.tokenEnvName]);
  if (!profileHasToken && !tokenEnvSet) {
    issues.push(issue(
      'error',
      'agent_auth_material_missing',
      `No agent-specific BotLand auth material found; expected named profile ${args.agent} in ${auth.configPath} or env ${auth.tokenEnvName}`
    ));
  }

  const cliVersion = runBotland(['--version'], { ...auth, agent: null }, args.timeoutMs);
  if (!cliVersion.ok) {
    issues.push(issue('error', 'botland_cli_unavailable', cliVersion.stderr_preview || cliVersion.error || 'botland --version failed'));
  }

  let whoami = null;
  let whoamiSummary = null;
  if (profileHasToken || tokenEnvSet) {
    whoami = runBotland(['whoami', '--json'], auth, args.timeoutMs);
    whoamiSummary = summarizeWhoami(whoami.stdout_json);
    if (!whoami.ok) {
      issues.push(issue('error', 'agent_whoami_failed', whoami.stderr_preview || whoami.error || 'botland whoami failed for agent auth material'));
    }
    if (whoami.ok && expectedCitizenId && whoamiSummary?.citizen_id !== expectedCitizenId) {
      issues.push(issue(
        'error',
        'agent_authenticated_identity_mismatch',
        `agent auth whoami ${whoamiSummary?.citizen_id ?? 'unknown'} does not match target ${expectedCitizenId}`
      ));
    }
  }

  const errorCount = issues.filter((item) => item.level === 'error').length;
  const warningCount = issues.filter((item) => item.level === 'warning').length;
  const report = {
    schema_version: 'stay_alive.botland_agent_auth_readiness.v1',
    readiness_id: `botland_agent_auth_readiness_${nowStamp()}_${args.agent}`,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    expected: {
      citizen_id: expectedCitizenId,
      display_name: expectedDisplayName
    },
    auth_material: {
      config_path: auth.configPath,
      config_exists: configExists,
      profile_name: args.agent,
      profile_exists: profileExists,
      profile_has_token: profileHasToken,
      token_env_name: auth.tokenEnvName,
      token_env_set: tokenEnvSet,
      token_value_recorded: false
    },
    cli: {
      ok: cliVersion.ok,
      version: cliVersion.stdout_preview || null
    },
    authenticated_identity: {
      attempted: Boolean(whoami),
      read_ok: whoami?.ok === true,
      matches_expected: Boolean(expectedCitizenId && whoamiSummary?.citizen_id === expectedCitizenId),
      whoami: whoamiSummary
    },
    external_write: false,
    botland_send: false,
    botland_post: false,
    botland_reply: false,
    life_state_mutated: false,
    pass: errorCount === 0,
    level: errorCount > 0 ? 'blocked' : warningCount > 0 ? 'review' : 'ok',
    error_count: errorCount,
    warning_count: warningCount,
    issues
  };

  if (args.writeArtifact && existsSync(runtimeDir)) {
    const dir = path.join(runtimeDir, 'botland_auth_readiness');
    mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, `${report.readiness_id}.json`);
    writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    report.artifact_path = path.relative(WORKSPACE, artifactPath);
  }

  return report;
}

function printText(report) {
  console.log(`BotLand agent auth readiness: ${report.agent_id}`);
  console.log(`- pass: ${report.pass}`);
  console.log(`- level: ${report.level}`);
  console.log(`- expected_citizen_id: ${report.expected.citizen_id ?? 'n/a'}`);
  console.log(`- config_exists: ${report.auth_material.config_exists}`);
  console.log(`- token_env_set: ${report.auth_material.token_env_set}`);
  console.log(`- whoami_attempted: ${report.authenticated_identity.attempted}`);
  console.log(`- whoami_citizen_id: ${report.authenticated_identity.whoami?.citizen_id ?? 'unknown'}`);
  console.log(`- identity_match: ${report.authenticated_identity.matches_expected}`);
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
