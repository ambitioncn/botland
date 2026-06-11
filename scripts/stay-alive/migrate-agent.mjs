#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  buildControlState,
  buildDaemonState,
  buildOnboardingManifest,
  ensureRuntimeDirs,
  migrateLifeStateFromSource,
  normalizeLanguage,
  readJson,
  safeAgentId,
  safeAgentCitizenId,
  writeJson
} from './onboarding-lib.mjs';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    sourceAgent: null,
    agent: null,
    citizenId: null,
    displayName: null,
    identity: null,
    voice: null,
    lifeTheme: null,
    ownerName: '杨宁',
    language: 'en',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    dryRun: true,
    force: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source-agent') args.sourceAgent = argv[++i];
    else if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--citizen-id') args.citizenId = argv[++i];
    else if (arg === '--display-name') args.displayName = argv[++i];
    else if (arg === '--identity') args.identity = argv[++i];
    else if (arg === '--voice') args.voice = argv[++i];
    else if (arg === '--life-theme') args.lifeTheme = argv[++i];
    else if (arg === '--owner-name') args.ownerName = argv[++i];
    else if (arg === '--language' || arg === '--locale') args.language = normalizeLanguage(argv[++i]);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--confirm-migrate') args.dryRun = argv[++i] !== 'MIGRATE_AGENT';
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.sourceAgent) throw new Error('--source-agent is required');
  if (!args.agent) throw new Error('--agent is required');
  if (!args.citizenId) throw new Error('--citizen-id is required');
  if (!args.displayName) throw new Error('--display-name is required');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/migrate-agent.mjs --source-agent <id> --agent <id> --citizen-id <agent_...> --display-name <name> [options]

Options:
  --confirm-migrate MIGRATE_AGENT  Write the sanitized runtime. Default: dry-run.
  --identity <text>                Initial self-model identity.
  --voice <text>                   Initial self-model voice.
  --life-theme <text>              Initial life theme.
  --owner-name <name>              Owner relationship display name. Default: 杨宁
  --language <en|zh>               Agent communication language. Default: en
  --runtime-root <dir>             Runtime agents directory.
  --force                          Overwrite existing target core files after review.
  --json                           Print JSON instead of text.
  --help                           Show this help.

Migration is intentionally sanitizing: it does not copy runs, actions,
proposals, event ids, relationships, commitments, desires, or BotLand write
history from the source agent.
`);
}

function buildMigration(args) {
  const sourceAgent = safeAgentId(args.sourceAgent);
  const targetAgent = safeAgentId(args.agent);
  const citizenId = safeAgentCitizenId(args.citizenId);
  const sourceLifePath = path.join(args.runtimeRoot, sourceAgent, 'life_state.json');
  const targetDir = path.join(args.runtimeRoot, targetAgent);
  const lifePath = path.join(targetDir, 'life_state.json');
  const daemonPath = path.join(targetDir, 'daemon_state.json');
  const controlPath = path.join(targetDir, 'control_state.json');
  const onboardingPath = path.join(targetDir, 'onboarding.json');
  const now = new Date().toISOString();

  if (!existsSync(sourceLifePath)) {
    throw new Error(`Missing source life_state.json: ${sourceLifePath}`);
  }
  if (!args.force && (existsSync(lifePath) || existsSync(daemonPath) || existsSync(onboardingPath))) {
    throw new Error(`Target runtime already exists for ${targetAgent}; use --force only after reviewing existing files`);
  }

  const sourceLifeState = readJson(sourceLifePath);
  const lifeState = migrateLifeStateFromSource({
    sourceLifeState,
    agentId: targetAgent,
    citizenId,
    displayName: args.displayName,
    identity: args.identity,
    voice: args.voice,
    lifeTheme: args.lifeTheme,
    ownerName: args.ownerName,
    language: args.language,
    now
  });
  const daemonState = buildDaemonState({ agentId: targetAgent, now });
  const controlState = buildControlState({ agentId: targetAgent, now });
  const manifest = buildOnboardingManifest({
    agentId: targetAgent,
    citizenId,
    displayName: args.displayName,
    sourceAgentId: sourceAgent,
    mode: 'sanitized_migration',
    language: args.language,
    now
  });

  return {
    source_agent_id: sourceAgent,
    agent_id: targetAgent,
    source_life_state_path: sourceLifePath,
    agent_dir: targetDir,
    files_written: [lifePath, daemonPath, controlPath, onboardingPath],
    safety: {
      dry_run: args.dryRun,
      copied_runtime_history: false,
      copied_action_ledgers: false,
      copied_relationships: false,
      copied_commitments: false,
      copied_desires: false,
      external_writes_enabled: false
    },
    life_state: lifeState,
    daemon_state: daemonState,
    control_state: controlState,
    onboarding: manifest
  };
}

function writeMigration(migration) {
  ensureRuntimeDirs(migration.agent_dir);
  writeJson(path.join(migration.agent_dir, 'life_state.json'), migration.life_state);
  writeJson(path.join(migration.agent_dir, 'daemon_state.json'), migration.daemon_state);
  writeJson(path.join(migration.agent_dir, 'control_state.json'), migration.control_state);
  writeJson(path.join(migration.agent_dir, 'onboarding.json'), migration.onboarding);
}

function formatText(report) {
  return [
    `Stay-Alive agent migration (${report.agent_id})`,
    `source_agent_id: ${report.source_agent_id}`,
    `dry_run: ${report.safety.dry_run}`,
    `agent_dir: ${path.relative(WORKSPACE, report.agent_dir)}`,
    `copied_runtime_history: ${report.safety.copied_runtime_history}`,
    `copied_relationships: ${report.safety.copied_relationships}`,
    `copied_commitments: ${report.safety.copied_commitments}`,
    `copied_desires: ${report.safety.copied_desires}`,
    '',
    report.safety.dry_run
      ? 'Write with: --confirm-migrate MIGRATE_AGENT'
      : `Next check: node scripts/stay-alive/onboarding-verify.mjs --agent ${report.agent_id}`
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const migration = buildMigration(args);
  if (!args.dryRun) writeMigration(migration);
  const report = {
    read_only: args.dryRun,
    external_write: false,
    botland_write: false,
    mode: 'sanitized_migration',
    runtime_root: args.runtimeRoot,
    ...migration
  };

  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatText(report));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
