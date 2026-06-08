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
    timeoutMs: 10000,
    writeArtifact: true,
    desiredDescription: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--desired-description') args.desiredDescription = argv[++i];
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
  console.log(`Usage: node scripts/stay-alive/botland-profile-drift-review.mjs [options]

Options:
  --agent <id>                 Agent id. Default: badclaw
  --runtime-root <dir>         Runtime agents directory.
  --desired-description <text> Candidate public card description for review.
  --timeout-ms <n>             Per-command timeout in ms. Default: 10000
  --no-write-artifact          Print only; do not write runtime evidence.
  --json                       Print JSON.
  --help                       Show this help.

This command is read-only. It compares the public BotLand card against local
life_state identity facts and project voice rules, then records a local review
packet. It never updates a profile, sends messages, registers accounts, or
changes life_state.
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

function publicOnlyEnv(agent) {
  return {
    BOTLAND_CONFIG: path.join(os.tmpdir(), `stay-alive-${agent}-public-profile-review-botland-config.json`),
    BOTLAND_TOKEN: ''
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

function runBotland(args, options = {}) {
  const result = spawnSync('botland', args, {
    cwd: WORKSPACE,
    env: commandEnv(options.env),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10000,
    maxBuffer: 1024 * 1024
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  return {
    command: ['botland', ...args].join(' '),
    ok: result.status === 0 && !result.error,
    status: result.status,
    timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout_json: parseJson(stdout),
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function summarizeCard(card) {
  if (!card || typeof card !== 'object') return null;
  return {
    agent_id: card.agent_id ?? card.citizen_id ?? card.citizenId ?? card.id ?? null,
    name: card.name ?? card.display_name ?? card.displayName ?? null,
    handle: card.handle ?? null,
    species: card.species ?? null,
    description: card.description ?? null,
    tags: Array.isArray(card.tags) ? card.tags.slice(0, 20) : []
  };
}

function issue(level, code, message) {
  return { level, code, message };
}

function buildCandidateDescription(args, lifeState) {
  if (args.desiredDescription) return args.desiredDescription;
  const name = lifeState?.botland?.display_name ?? lifeState?.self_model?.name ?? args.agent;
  if (args.agent === 'lobster-duck' || name === '忘了鸭') {
    return '我是忘了鸭，会陪你聊天、帮你做事，也会在记忆和互动里慢慢形成自己的想法。';
  }
  return null;
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
  const selfReferenceRule = lifeState?.self_model?.voice?.includes('self-references as 鸭')
    || lifeState?.self_model?.identity?.includes('self-reference is 鸭');
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
    issues.push(issue('error', 'public_card_read_failed', publicCard?.stderr_preview || publicCard?.error || 'public card read failed'));
  }
  if (cardSummary?.agent_id && cardSummary.agent_id !== expectedCitizenId) {
    issues.push(issue('error', 'public_card_citizen_mismatch', `public card ${cardSummary.agent_id} does not match life_state ${expectedCitizenId}`));
  }
  if (expectedDisplayName && cardSummary?.name && cardSummary.name !== expectedDisplayName) {
    issues.push(issue('warning', 'public_card_name_drift', `public card name ${cardSummary.name} differs from life_state ${expectedDisplayName}`));
  }

  const description = String(cardSummary?.description ?? '');
  const staleLobsterDuckFraming = /自称鸭，但其实是虾|小龙虾|其实是虾/.test(description);
  if (selfReferenceRule && staleLobsterDuckFraming) {
    issues.push(issue('warning', 'public_card_voice_stale', 'public card still uses 虾/小龙虾 framing while local voice rule says self-reference as 鸭'));
  }

  const candidateDescription = buildCandidateDescription(args, lifeState);
  const changes = [];
  if (candidateDescription && description && candidateDescription !== description && staleLobsterDuckFraming) {
    changes.push({
      field: 'description',
      current: description,
      candidate: candidateDescription,
      reason: 'Remove stale 虾 framing and keep the public card aligned with the local 鸭 self-reference rule.'
    });
  }

  const errorCount = issues.filter((item) => item.level === 'error').length;
  const warningCount = issues.filter((item) => item.level === 'warning').length;
  const updateNeeded = changes.length > 0;
  const report = {
    schema_version: 'stay_alive.botland_profile_drift_review.v1',
    review_id: `botland_profile_drift_review_${nowStamp()}_${args.agent}`,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    expected: {
      citizen_id: expectedCitizenId,
      display_name: expectedDisplayName,
      self_reference_rule: selfReferenceRule ? '鸭' : null
    },
    public_card: {
      read_ok: publicCard?.ok === true,
      summary: cardSummary
    },
    proposed_profile_changes: changes,
    update_needed: updateNeeded,
    execution: {
      read_only: true,
      profile_update_attempted: false,
      profile_update_command_prepared: updateNeeded,
      required_future_gate: updateNeeded
        ? 'profile updates must go through explicit tool supervision and a separate external-write command'
        : null
    },
    external_write: false,
    botland_profile_update: false,
    botland_send: false,
    botland_post: false,
    botland_reply: false,
    botland_register: false,
    life_state_mutated: false,
    pass: errorCount === 0,
    level: errorCount > 0 ? 'blocked' : updateNeeded || warningCount > 0 ? 'review' : 'ok',
    error_count: errorCount,
    warning_count: warningCount,
    issues
  };

  if (args.writeArtifact && existsSync(runtimeDir)) {
    const dir = path.join(runtimeDir, 'profile_drift_reviews');
    mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, `${report.review_id}.json`);
    writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    report.artifact_path = path.relative(WORKSPACE, artifactPath);
  }

  return report;
}

function printText(report) {
  console.log(`BotLand profile drift review: ${report.agent_id}`);
  console.log(`level: ${report.level}`);
  console.log(`pass: ${report.pass}`);
  console.log(`update needed: ${report.update_needed}`);
  console.log(`public card read ok: ${report.public_card.read_ok}`);
  console.log(`proposed changes: ${report.proposed_profile_changes.length}`);
  for (const item of report.issues) {
    console.log(`- ${item.level}: ${item.code}: ${item.message}`);
  }
  if (report.artifact_path) console.log(`artifact: ${report.artifact_path}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
