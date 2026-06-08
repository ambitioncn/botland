#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { initializeAgentRuntime } from './onboarding-lib.mjs';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: null,
    citizenId: null,
    displayName: null,
    identity: null,
    voice: null,
    lifeTheme: null,
    ownerName: '杨宁',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    force: false,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--citizen-id') args.citizenId = argv[++i];
    else if (arg === '--display-name') args.displayName = argv[++i];
    else if (arg === '--identity') args.identity = argv[++i];
    else if (arg === '--voice') args.voice = argv[++i];
    else if (arg === '--life-theme') args.lifeTheme = argv[++i];
    else if (arg === '--owner-name') args.ownerName = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.agent) throw new Error('--agent is required');
  if (!args.citizenId) throw new Error('--citizen-id is required');
  if (!args.displayName) throw new Error('--display-name is required');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/init-agent.mjs --agent <id> --citizen-id <agent_...> --display-name <name> [options]

Options:
  --identity <text>      Initial self-model identity.
  --voice <text>         Initial self-model voice.
  --life-theme <text>    Initial life theme.
  --owner-name <name>    Owner relationship display name. Default: 杨宁
  --runtime-root <dir>   Runtime agents directory.
  --force                Overwrite existing core runtime files after review.
  --json                 Print JSON instead of text.
  --help                 Show this help.

This command creates a fresh Stay-Alive runtime from the generic template. It
does not copy BadClaw runtime history and does not call BotLand.
`);
}

function formatText(report) {
  return [
    `Stay-Alive agent initialized (${report.agent_id})`,
    `agent_dir: ${path.relative(WORKSPACE, report.agent_dir)}`,
    `botland_citizen_id: ${report.onboarding.botland_citizen_id}`,
    `display_name: ${report.onboarding.display_name}`,
    `template_bundle: ${report.template_bundle?.template_name ?? 'unknown'}`,
    `default_timers: ${report.template_bundle?.timers?.length ?? 0}`,
    `files_written: ${report.files_written.map((file) => path.relative(WORKSPACE, file)).join(', ')}`,
    '',
    'Next checks:',
    `  node scripts/stay-alive/onboarding-verify.mjs --agent ${report.agent_id}`,
    `  node scripts/stay-alive/life-state-verify.mjs --agent ${report.agent_id}`,
    `  node scripts/stay-alive/preflight.mjs --agent ${report.agent_id} --no-checkpoint --strict-onboarding`,
    `  bash scripts/stay-alive/install-systemd-user-timers.sh ${report.agent_id}`,
    `  node scripts/stay-alive/regression-suite.mjs --agent ${report.agent_id}`
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = initializeAgentRuntime({
    runtimeRoot: args.runtimeRoot,
    agentId: args.agent,
    citizenId: args.citizenId,
    displayName: args.displayName,
    identity: args.identity,
    voice: args.voice,
    lifeTheme: args.lifeTheme,
    ownerName: args.ownerName,
    force: args.force
  });
  const report = {
    read_only: false,
    external_write: false,
    botland_write: false,
    mode: 'init',
    runtime_root: args.runtimeRoot,
    ...result
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
