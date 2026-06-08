#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { readJson } from './proposal-lib.mjs';
import {
  evaluateMutation,
  mutationProtocol,
  verifyLifeStateMutationProtocol
} from './life-state-mutation-protocol-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    actor: null,
    path: null,
    operation: 'update',
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--actor') args.actor = argv[++i];
    else if (arg === '--path') args.path = argv[++i];
    else if (arg === '--operation') args.operation = argv[++i];
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/life-state-mutation-protocol.mjs [options]

Read-only verifier/evaluator for the Stay-Alive life_state mutation protocol.
It records that daily lifecycle evolution does not require human confirmation;
mutations are controlled by actor-specific autonomous gates and local ledgers.

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory
  --actor <actor>          Optional actor to evaluate
  --path <life_state.path> Optional life_state path to evaluate
  --operation <name>       Operation label. Default: update
  --json                   Print JSON
`);
}

function buildReport(args) {
  const lifeStatePath = path.join(args.runtimeRoot, args.agent, 'life_state.json');
  const lifeState = readJson(lifeStatePath);
  const protocolVerification = verifyLifeStateMutationProtocol(lifeState);
  const evaluation = args.actor && args.path
    ? evaluateMutation({
        actor: args.actor,
        path: args.path,
        operation: args.operation,
        evidence: { source: 'read_only_protocol_probe' }
      })
    : null;
  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    protocol: mutationProtocol(),
    protocol_verification: protocolVerification,
    evaluation,
    pass: protocolVerification.pass && (evaluation ? evaluation.allowed : true),
    level: protocolVerification.pass && (!evaluation || evaluation.allowed) ? 'ok' : 'stop'
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive life_state mutation protocol (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `read_only: yes`,
    `daily_human_confirmation_required: no`,
    `pass: ${report.pass ? 'yes' : 'no'}`,
    '',
    'Surfaces'
  ];
  for (const surface of report.protocol.surfaces) {
    lines.push(`- ${surface.actor}: ${surface.authority}; paths=${surface.paths.join(', ')}`);
  }
  if (report.evaluation) {
    lines.push('');
    lines.push('Evaluation');
    lines.push(`- actor: ${report.evaluation.actor}`);
    lines.push(`- path: ${report.evaluation.path}`);
    lines.push(`- allowed: ${report.evaluation.allowed ? 'yes' : 'no'}`);
    if (report.evaluation.issues.length > 0) {
      for (const issue of report.evaluation.issues) lines.push(`- ${issue.code}: ${issue.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
