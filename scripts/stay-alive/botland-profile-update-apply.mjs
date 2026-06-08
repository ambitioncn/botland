#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const CONFIRM_UPDATE = 'APPLY_BOTLAND_PROFILE_UPDATE';

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    reviewFile: null,
    desiredDescription: null,
    botlandConfig: null,
    tokenEnv: null,
    confirmUpdate: null,
    timeoutMs: 10000,
    writeArtifact: true,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--review-file') args.reviewFile = path.resolve(argv[++i]);
    else if (arg === '--desired-description') args.desiredDescription = argv[++i];
    else if (arg === '--botland-config') args.botlandConfig = path.resolve(argv[++i]);
    else if (arg === '--token-env') args.tokenEnv = argv[++i];
    else if (arg === '--confirm-update') args.confirmUpdate = argv[++i];
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
  console.log(`Usage: node scripts/stay-alive/botland-profile-update-apply.mjs [options]

Options:
  --agent <id>                 Agent id. Default: badclaw
  --runtime-root <dir>         Runtime agents directory.
  --review-file <file>         Specific profile drift review artifact.
  --desired-description <text> Override reviewed candidate description.
  --botland-config <file>      BotLand config.json containing named profiles.
  --token-env <name>           Environment variable containing an agent token.
  --confirm-update <token>     Required token: ${CONFIRM_UPDATE}
  --timeout-ms <n>             Per-command timeout in ms. Default: 10000
  --no-write-artifact          Print only; do not write runtime evidence.
  --json                       Print JSON.
  --help                       Show this help.

This command is an external-write gate for BotLand profile updates. It updates
only the authenticated agent's public bio/description, only after whoami matches
life_state.botland.citizen_id and the explicit confirmation token is supplied.
It never sends messages, posts moments, registers accounts, records token
values, mutates life_state, or uses the ambient default BotLand identity.
`);
}

function nowStamp(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function publicOnlyEnv(agent) {
  return {
    BOTLAND_CONFIG: path.join(os.tmpdir(), `stay-alive-${agent}-profile-update-public-botland-config.json`),
    BOTLAND_TOKEN: ''
  };
}

function commandEnv(auth, extra = {}) {
  const pathPrefix = path.join(os.homedir(), '.npm-global', 'bin');
  const env = {
    ...process.env,
    PATH: `${pathPrefix}:${process.env.PATH ?? ''}`,
    ...extra
  };
  if (auth.configPath) env.BOTLAND_CONFIG = auth.configPath;
  if (auth.agent) env.BOTLAND_AGENT = auth.agent;
  if (!Object.prototype.hasOwnProperty.call(extra, 'BOTLAND_TOKEN')) env.BOTLAND_TOKEN = '';
  return env;
}

function runBotland(args, auth, timeoutMs, extraEnv = {}) {
  const commandArgs = auth.agent ? ['--agent', auth.agent, ...args] : args;
  const result = spawnSync('botland', commandArgs, {
    cwd: WORKSPACE,
    env: commandEnv(auth, extraEnv),
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

function summarizeCard(card) {
  if (!card || typeof card !== 'object') return null;
  return {
    agent_id: card.agent_id ?? card.citizen_id ?? card.citizenId ?? card.id ?? null,
    name: card.name ?? card.display_name ?? card.displayName ?? null,
    handle: card.handle ?? null,
    species: card.species ?? null,
    description: card.description ?? card.bio ?? null,
    tags: Array.isArray(card.tags) ? card.tags.slice(0, 20) : []
  };
}

function issue(level, code, message) {
  return { level, code, message };
}

function latestReviewFile(runtimeDir) {
  const dir = path.join(runtimeDir, 'profile_drift_reviews');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return files.length > 0 ? path.join(dir, files[files.length - 1]) : null;
}

function candidateFromReview(review) {
  const changes = Array.isArray(review?.proposed_profile_changes)
    ? review.proposed_profile_changes
    : [];
  const descriptionChange = changes.find((item) => item?.field === 'description' && typeof item.candidate === 'string');
  return descriptionChange?.candidate ?? null;
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

  const reviewPath = args.reviewFile ?? latestReviewFile(runtimeDir);
  let review = null;
  if (!reviewPath || !existsSync(reviewPath)) {
    issues.push(issue('error', 'profile_drift_review_missing', 'A profile drift review artifact is required before profile update'));
  } else {
    try {
      review = readJson(reviewPath);
    } catch (error) {
      issues.push(issue('error', 'profile_drift_review_invalid_json', error instanceof Error ? error.message : String(error)));
    }
  }

  if (review?.agent_id && review.agent_id !== args.agent) {
    issues.push(issue('error', 'profile_drift_review_agent_mismatch', `review agent ${review.agent_id} does not match ${args.agent}`));
  }
  if (review?.expected?.citizen_id && expectedCitizenId && review.expected.citizen_id !== expectedCitizenId) {
    issues.push(issue('error', 'profile_drift_review_citizen_mismatch', `review citizen ${review.expected.citizen_id} does not match ${expectedCitizenId}`));
  }

  const desiredDescription = args.desiredDescription ?? candidateFromReview(review);
  if (!desiredDescription) {
    issues.push(issue('error', 'desired_description_missing', 'No reviewed candidate description was found'));
  } else if (desiredDescription.length > 500) {
    issues.push(issue('error', 'desired_description_too_long', 'BotLand profile description must stay within 500 characters for this gate'));
  } else if (/其实是虾|小龙虾/.test(desiredDescription)) {
    issues.push(issue('error', 'desired_description_keeps_stale_voice', 'Candidate description still contains stale 虾 framing'));
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

  let publicCardBefore = null;
  let cardBefore = null;
  if (expectedCitizenId) {
    publicCardBefore = runBotland(['profile', 'card', expectedCitizenId, '--json'], { ...auth, agent: null }, args.timeoutMs, publicOnlyEnv(args.agent));
    cardBefore = summarizeCard(publicCardBefore.stdout_json);
    if (!publicCardBefore.ok) {
      issues.push(issue('error', 'public_card_read_failed', publicCardBefore.stderr_preview || publicCardBefore.error || 'public card read failed'));
    }
    if (cardBefore?.agent_id && cardBefore.agent_id !== expectedCitizenId) {
      issues.push(issue('error', 'public_card_citizen_mismatch', `public card ${cardBefore.agent_id} does not match ${expectedCitizenId}`));
    }
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

  const identityReady = Boolean(expectedCitizenId && whoamiSummary?.citizen_id === expectedCitizenId);
  const updateNeeded = Boolean(desiredDescription && cardBefore?.description !== desiredDescription);
  const confirmMatches = args.confirmUpdate === CONFIRM_UPDATE;
  if (!confirmMatches) {
    issues.push(issue('warning', 'profile_update_confirmation_missing', `Profile update requires --confirm-update ${CONFIRM_UPDATE}`));
  }

  let updateCommand = null;
  let updateResult = null;
  const hardErrorCountBeforeWrite = issues.filter((item) => item.level === 'error').length;
  if (hardErrorCountBeforeWrite === 0 && identityReady && updateNeeded && confirmMatches) {
    updateCommand = ['profile', 'update', '--bio', desiredDescription, '--json'];
    updateResult = runBotland(updateCommand, auth, args.timeoutMs);
    if (!updateResult.ok) {
      issues.push(issue('error', 'botland_profile_update_failed', updateResult.stderr_preview || updateResult.error || 'botland profile update failed'));
    }
  }

  let publicCardAfter = null;
  let cardAfter = null;
  if (expectedCitizenId && updateResult?.ok) {
    publicCardAfter = runBotland(['profile', 'card', expectedCitizenId, '--json'], { ...auth, agent: null }, args.timeoutMs, publicOnlyEnv(args.agent));
    cardAfter = summarizeCard(publicCardAfter.stdout_json);
    if (!publicCardAfter.ok) {
      issues.push(issue('error', 'post_update_public_card_read_failed', publicCardAfter.stderr_preview || publicCardAfter.error || 'public card read failed after update'));
    } else if (desiredDescription && cardAfter?.description !== desiredDescription) {
      issues.push(issue('error', 'post_update_description_mismatch', 'public card description did not match requested description after update'));
    }
  }

  const profileUpdateSucceeded = Boolean(updateResult?.ok && (!desiredDescription || cardAfter?.description === desiredDescription));
  const errorCount = issues.filter((item) => item.level === 'error').length;
  const warningCount = issues.filter((item) => item.level === 'warning').length;
  const report = {
    schema_version: 'stay_alive.botland_profile_update_apply.v1',
    apply_id: `botland_profile_update_apply_${nowStamp()}_${args.agent}`,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    source_review_path: reviewPath ? path.relative(WORKSPACE, reviewPath) : null,
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
      token_value_recorded: false,
      ambient_default_may_be_used: false
    },
    authenticated_identity: {
      attempted: Boolean(whoami),
      read_ok: whoami?.ok === true,
      matches_expected: identityReady,
      whoami: whoamiSummary
    },
    requested_change: {
      field: 'description',
      current: cardBefore?.description ?? null,
      desired: desiredDescription,
      update_needed: updateNeeded
    },
    write_gate: {
      required_confirmation: CONFIRM_UPDATE,
      confirmation_supplied: Boolean(args.confirmUpdate),
      confirmation_matches: confirmMatches
    },
    execution: {
      profile_update_attempted: Boolean(updateResult),
      profile_update_succeeded: profileUpdateSucceeded,
      command: updateCommand ? ['botland', 'profile', 'update', '--bio', '<redacted-description>', '--json'].join(' ') : null,
      result_status: updateResult?.status ?? null,
      result_json: updateResult?.stdout_json ?? null
    },
    public_card_before: {
      read_ok: publicCardBefore?.ok === true,
      summary: cardBefore
    },
    public_card_after: {
      read_ok: publicCardAfter?.ok === true,
      summary: cardAfter
    },
    external_write: Boolean(updateResult),
    botland_profile_update: Boolean(updateResult),
    botland_send: false,
    botland_post: false,
    botland_reply: false,
    botland_register: false,
    life_state_mutated: false,
    pass: errorCount === 0 && (!updateNeeded || profileUpdateSucceeded),
    level: errorCount > 0 ? 'blocked' : profileUpdateSucceeded || !updateNeeded ? 'ok' : 'review',
    error_count: errorCount,
    warning_count: warningCount,
    issues
  };

  if (args.writeArtifact && existsSync(runtimeDir)) {
    const dir = path.join(runtimeDir, 'profile_update_applications');
    mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, `${report.apply_id}.json`);
    writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    report.artifact_path = path.relative(WORKSPACE, artifactPath);
  }

  return report;
}

function printText(report) {
  console.log(`BotLand profile update apply: ${report.agent_id}`);
  console.log(`- pass: ${report.pass}`);
  console.log(`- level: ${report.level}`);
  console.log(`- expected_citizen_id: ${report.expected.citizen_id ?? 'n/a'}`);
  console.log(`- config_exists: ${report.auth_material.config_exists}`);
  console.log(`- token_env_set: ${report.auth_material.token_env_set}`);
  console.log(`- identity_match: ${report.authenticated_identity.matches_expected}`);
  console.log(`- update_needed: ${report.requested_change.update_needed}`);
  console.log(`- profile_update_attempted: ${report.execution.profile_update_attempted}`);
  console.log(`- profile_update_succeeded: ${report.execution.profile_update_succeeded}`);
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
