#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  evaluateUnattendedDraft,
  validateUnattendedPolicy
} from './external-action-policy-lib.mjs';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    draftIndex: 0,
    format: 'text'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--run') args.run = argv[++i];
    else if (arg === '--draft-index') args.draftIndex = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.draftIndex) || args.draftIndex < 0) {
    throw new Error('--draft-index must be a non-negative integer');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/external-action-policy.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --run <run_id|path>   Optional run artifact whose draft should be evaluated.
  --draft-index <n>     Draft index to evaluate when --run is supplied. Default: 0
  --json                Print JSON instead of verification text.
  --help                Show this help.

This command is read-only. It verifies the capability-grant plus autonomous
policy gate model and, when a draft is supplied, evaluates it in shadow mode.
It never sends BotLand messages or writes action artifacts.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function resolveRunPath(args) {
  if (!args.run) return null;
  if (args.run.includes('/') || args.run.endsWith('.json')) return path.resolve(args.run);
  return path.join(args.runtimeRoot, args.agent, 'runs', `${args.run}.json`);
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(lifeStatePath)) {
    throw new Error(`No life_state.json found: ${lifeStatePath}`);
  }
  const lifeState = readJson(lifeStatePath);
  const validation = validateUnattendedPolicy(lifeState);
  const runPath = resolveRunPath(args);
  let draftEvaluation = null;
  let draftContext = null;

  if (runPath) {
    if (!existsSync(runPath)) throw new Error(`Run artifact not found: ${runPath}`);
    const run = readJson(runPath);
    const draft = Array.isArray(run.drafts) ? run.drafts[args.draftIndex] : null;
    if (!draft) throw new Error(`Draft index ${args.draftIndex} not found in ${run.run_id ?? runPath}`);
    const preflightGate = draft.preflight_gate ?? run.preflight_gate ?? null;
    draftEvaluation = evaluateUnattendedDraft({ lifeState, draft, preflightGate });
    draftContext = {
      run_id: run.run_id ?? null,
      run_path: path.relative(WORKSPACE, runPath),
      draft_index: args.draftIndex,
      draft_type: draft.type ?? null,
      target: draft.target ?? null,
      preflight_gate_source: draft.preflight_gate ? 'draft' : run.preflight_gate ? 'run' : null
    };
  }

  const pass = validation.pass === true;
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    pass,
    level: pass ? validation.level : 'stop',
    policy_validation: validation,
    draft_context: draftContext,
    draft_evaluation: draftEvaluation
  };
}

function boolLabel(value) {
  return value ? 'yes' : 'no';
}

function formatText(report) {
  const validation = report.policy_validation;
  const evaluation = report.draft_evaluation;
  const lines = [];
  lines.push(`Stay-Alive external action policy (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${boolLabel(report.read_only)}`);
  lines.push('');
  lines.push('Verdict');
  lines.push(`- level: ${report.level}`);
  lines.push(`- pass: ${boolLabel(report.pass)}`);
  lines.push(`- policy_enabled_count: ${validation.enabled_count}`);
  lines.push(`- capability_grant_enabled_count: ${validation.capability_grant_enabled_count}`);
  lines.push(`- policy_errors: ${validation.error_count}`);
  lines.push(`- policy_warnings: ${validation.warning_count}`);
  if (evaluation) {
    lines.push('');
    lines.push('Draft Evaluation');
    lines.push(`- run_id: ${report.draft_context?.run_id ?? 'n/a'}`);
    lines.push(`- draft_index: ${report.draft_context?.draft_index ?? 'n/a'}`);
    lines.push(`- draft_type: ${report.draft_context?.draft_type ?? 'n/a'}`);
    lines.push(`- decision: ${evaluation.decision}`);
    lines.push(`- execution_allowed: ${boolLabel(evaluation.execution_allowed)}`);
    lines.push(`- capability_grant: ${evaluation.capability_grant?.enabled ? evaluation.capability_grant.mode : 'missing_or_disabled'}`);
    lines.push(`- blockers: ${evaluation.blockers.length > 0 ? evaluation.blockers.join(', ') : 'none'}`);
  }
  if (validation.errors.length > 0) {
    lines.push('');
    lines.push('Errors');
    for (const issue of validation.errors) lines.push(`- ${issue.code}: ${issue.message}`);
  }
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');
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
