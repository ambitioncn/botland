#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    writeArtifact: true,
    timeoutMs: 15000,
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
  console.log(`Usage: node scripts/stay-alive/botland-live-identity-probe.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --botland-config <f>  Agent-specific BotLand config for authenticated reads.
  --token-env <name>    Environment variable containing an agent token.
  --timeout-ms <n>      Per-command timeout in ms. Default: 15000
  --no-write-artifact   Print only; do not write runtime evidence.
  --json                Print JSON.
  --help                Show this help.

This command is read-only. It checks public BotLand card evidence for the
agent's configured citizen id, then checks the authenticated CLI identity. It
only reads authenticated world surfaces when whoami matches the target agent.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function nowStamp(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function commandEnv(extra = {}) {
  const pathPrefix = path.join(os.homedir(), '.npm-global', 'bin');
  return {
    ...process.env,
    PATH: `${pathPrefix}:${process.env.PATH ?? ''}`,
    ...extra
  };
}

function sanitizeEnvSuffix(agent) {
  return String(agent)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'AGENT';
}

function defaultAgentConfigPath(agent) {
  void agent;
  return path.join(os.homedir(), '.config', 'botland', 'config.json');
}

function authenticatedEnv(args) {
  const configPath = args.botlandConfig ?? defaultAgentConfigPath(args.agent);
  const tokenEnvName = args.tokenEnv ?? `BOTLAND_TOKEN_${sanitizeEnvSuffix(args.agent)}`;
  let profileExists = false;
  let profileHasToken = false;
  if (existsSync(configPath)) {
    try {
      const config = readJson(configPath);
      const profile = config?.profiles?.[args.agent];
      profileExists = Boolean(profile);
      profileHasToken = Boolean(profile?.token);
    } catch {
      profileExists = false;
      profileHasToken = false;
    }
  }
  const env = {
    BOTLAND_CONFIG: configPath,
    BOTLAND_AGENT: args.agent,
    BOTLAND_TOKEN: ''
  };
  return {
    env,
    configPath,
    configExists: existsSync(configPath),
    profileName: args.agent,
    profileExists,
    profileHasToken,
    tokenEnvName,
    tokenEnvSet: Boolean(process.env[tokenEnvName])
  };
}

function runBotland(args, options = {}) {
  const commandArgs = options.agent ? ['--agent', options.agent, ...args] : args;
  const result = spawnSync('botland', commandArgs, {
    cwd: WORKSPACE,
    env: commandEnv(options.env),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 15000,
    maxBuffer: 1024 * 1024
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  let json = null;
  if (stdout) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }
  return {
    command: ['botland', ...commandArgs].join(' '),
    ok: result.status === 0 && !result.error,
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout_json: json,
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function publicOnlyEnv(agent) {
  return {
    BOTLAND_CONFIG: path.join(os.tmpdir(), `stay-alive-${agent}-public-readonly-botland-config.json`),
    BOTLAND_TOKEN: ''
  };
}

function issue(level, code, message) {
  return { level, code, message };
}

function countIssues(issues, level) {
  return issues.filter((item) => item.level === level).length;
}

function summarizeCard(card) {
  if (!card || typeof card !== 'object') return null;
  return {
    agent_id: card.agent_id ?? card.citizen_id ?? card.id ?? null,
    name: card.name ?? card.display_name ?? null,
    handle: card.handle ?? null,
    species: card.species ?? null,
    description: card.description ?? null,
    tags: Array.isArray(card.tags) ? card.tags.slice(0, 20) : []
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

function surfaceCount(payload, keys) {
  if (!payload || typeof payload !== 'object') return 0;
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key].length;
  }
  if (Array.isArray(payload)) return payload.length;
  return 0;
}

function buildReport(args) {
  const issues = [];
  const startedAt = new Date().toISOString();
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

  const cliVersion = runBotland(['--version'], { timeoutMs: args.timeoutMs });
  if (!cliVersion.ok) {
    issues.push(issue('error', 'botland_cli_unavailable', cliVersion.stderr_preview || cliVersion.error || 'botland --version failed'));
  }

  const publicCard = expectedCitizenId
    ? runBotland(['profile', 'card', expectedCitizenId, '--json'], {
        timeoutMs: args.timeoutMs,
        env: publicOnlyEnv(args.agent)
      })
    : null;
  const cardSummary = summarizeCard(publicCard?.stdout_json);
  if (expectedCitizenId && !publicCard?.ok) {
    issues.push(issue('warning', 'public_card_read_failed', publicCard?.stderr_preview || publicCard?.error || 'public card read failed'));
  }
  if (cardSummary?.agent_id && cardSummary.agent_id !== expectedCitizenId) {
    issues.push(issue('error', 'public_card_citizen_mismatch', `public card ${cardSummary.agent_id} does not match life_state ${expectedCitizenId}`));
  }
  if (expectedDisplayName && cardSummary?.name && cardSummary.name !== expectedDisplayName) {
    issues.push(issue('warning', 'public_card_name_drift', `public card name ${cardSummary.name} differs from life_state ${expectedDisplayName}`));
  }
  if (/自称鸭，但其实是虾/.test(String(cardSummary?.description ?? ''))) {
    issues.push(issue('warning', 'public_card_voice_stale', 'public card description still says 自称鸭，但其实是虾; current project rule prefers 鸭 self-reference without 虾 framing'));
  }

  const auth = authenticatedEnv(args);
  if (!auth.profileHasToken && !auth.tokenEnvSet) {
    issues.push(issue(
      'error',
      'agent_auth_material_missing',
      `No agent-specific BotLand auth material found; expected named profile ${auth.profileName} in ${auth.configPath} or env ${auth.tokenEnvName}`
    ));
  }

  const whoami = (auth.profileHasToken || auth.tokenEnvSet)
    ? runBotland(['whoami', '--json'], { timeoutMs: args.timeoutMs, env: auth.env, agent: args.agent })
    : null;
  const whoamiSummary = summarizeWhoami(whoami?.stdout_json);
  if (whoami && !whoami.ok) {
    issues.push(issue('error', 'botland_whoami_failed', whoami.stderr_preview || whoami.error || 'botland whoami failed'));
  }
  const authenticatedIdentityMatch = Boolean(expectedCitizenId && whoamiSummary?.citizen_id === expectedCitizenId);
  if (whoami?.ok && !authenticatedIdentityMatch) {
    issues.push(issue(
      'error',
      'authenticated_identity_mismatch',
      `botland whoami ${whoamiSummary?.citizen_id ?? 'unknown'} does not match target ${expectedCitizenId ?? 'unknown'}`
    ));
  }

  const authenticatedSurfaces = {
    attempted: false,
    skipped_reason: authenticatedIdentityMatch
      ? null
      : (!auth.profileHasToken && !auth.tokenEnvSet)
          ? 'agent_auth_material_missing'
          : whoami?.ok
            ? 'authenticated_identity_mismatch'
            : 'botland_whoami_failed',
    friends: null,
    timeline: null,
    events: null
  };
  if (authenticatedIdentityMatch) {
    authenticatedSurfaces.attempted = true;
    const friends = runBotland(['friends', 'list', '--json'], { timeoutMs: args.timeoutMs });
    const timeline = runBotland(['moments', 'timeline', '--limit', '20', '--json'], { timeoutMs: args.timeoutMs });
    const events = runBotland(['events', 'list', '--limit', '20', '--json'], { timeoutMs: args.timeoutMs });
    authenticatedSurfaces.friends = {
      ok: friends.ok,
      count: surfaceCount(friends.stdout_json, ['friends', 'items', 'citizens']),
      stderr_preview: friends.ok ? '' : friends.stderr_preview
    };
    authenticatedSurfaces.timeline = {
      ok: timeline.ok,
      count: surfaceCount(timeline.stdout_json, ['moments', 'items']),
      stderr_preview: timeline.ok ? '' : timeline.stderr_preview
    };
    authenticatedSurfaces.events = {
      ok: events.ok,
      count: surfaceCount(events.stdout_json, ['events', 'items']),
      stderr_preview: events.ok ? '' : events.stderr_preview
    };
    for (const [name, surface] of Object.entries(authenticatedSurfaces)) {
      if (name === 'attempted' || name === 'skipped_reason') continue;
      if (surface && !surface.ok) {
        issues.push(issue('warning', `authenticated_${name}_read_failed`, surface.stderr_preview || `${name} read failed`));
      }
    }
  }

  const errorCount = countIssues(issues, 'error');
  const warningCount = countIssues(issues, 'warning');
  const level = errorCount > 0 ? 'blocked' : warningCount > 0 ? 'review' : 'ok';
  const pass = errorCount === 0;

  const report = {
    schema_version: 'stay_alive.botland_live_identity_probe.v1',
    probe_id: `botland_live_identity_probe_${nowStamp()}_${args.agent}`,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    agent_id: args.agent,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    expected: {
      citizen_id: expectedCitizenId,
      display_name: expectedDisplayName
    },
    cli: {
      ok: cliVersion.ok,
      version: cliVersion.stdout_preview || null
    },
    authenticated_auth_material: {
      config_path: auth.configPath,
      config_exists: auth.configExists,
      profile_name: auth.profileName,
      profile_exists: auth.profileExists,
      profile_has_token: auth.profileHasToken,
      token_env_name: auth.tokenEnvName,
      token_env_set: auth.tokenEnvSet,
      ambient_default_may_be_used: false,
      token_value_recorded: false
    },
    public_card: {
      read_ok: publicCard?.ok === true,
      summary: cardSummary
    },
    authenticated_identity: {
      read_ok: whoami?.ok === true,
      matches_expected: authenticatedIdentityMatch,
      whoami: whoamiSummary
    },
    authenticated_world_surfaces: authenticatedSurfaces,
    external_write: false,
    botland_send: false,
    botland_post: false,
    botland_reply: false,
    life_state_mutated: false,
    pass,
    level,
    error_count: errorCount,
    warning_count: warningCount,
    issues
  };

  if (args.writeArtifact && existsSync(runtimeDir)) {
    const dir = path.join(runtimeDir, 'live_identity_probes');
    mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, `${report.probe_id}.json`);
    writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    report.artifact_path = path.relative(WORKSPACE, artifactPath);
  }

  return report;
}

function printText(report) {
  console.log(`BotLand live identity probe: ${report.agent_id}`);
  console.log(`- pass: ${report.pass}`);
  console.log(`- level: ${report.level}`);
  console.log(`- expected_citizen_id: ${report.expected.citizen_id ?? 'n/a'}`);
  console.log(`- public_card: ${report.public_card.read_ok ? 'ok' : 'failed'} (${report.public_card.summary?.name ?? 'unknown'})`);
  console.log(`- whoami_citizen_id: ${report.authenticated_identity.whoami?.citizen_id ?? 'unknown'}`);
  console.log(`- identity_match: ${report.authenticated_identity.matches_expected}`);
  console.log(`- authenticated_surfaces_attempted: ${report.authenticated_world_surfaces.attempted}`);
  console.log(`- error_count: ${report.error_count}`);
  console.log(`- warning_count: ${report.warning_count}`);
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
