#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { evaluateUnattendedDraft, validateUnattendedPolicy } from './external-action-policy-lib.mjs';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 200,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/unattended-write-shadow.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent run artifacts to inspect. Default: 200
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It evaluates historical drafts against the active
tool supervision policy to estimate executable eligibility and risk.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listRuns(runsDir, limit) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, limit);
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(lifeStatePath)) throw new Error(`Missing life_state.json: ${lifeStatePath}`);
  const lifeState = readJson(lifeStatePath);
  const validation = validateUnattendedPolicy(lifeState);
  const draftEvaluations = [];
  for (const file of listRuns(path.join(agentDir, 'runs'), args.limit)) {
    let run = null;
    try {
      run = readJson(file);
    } catch {
      continue;
    }
    const drafts = Array.isArray(run.drafts) ? run.drafts : [];
    drafts.forEach((draft, index) => {
      const evaluation = evaluateUnattendedDraft({
        lifeState,
        draft,
        preflightGate: { pass: true, ok: true, safety_findings: [] }
      });
      draftEvaluations.push({
        run_id: run.run_id,
        run_created_at: run.created_at ?? null,
        run_path: path.relative(WORKSPACE, file),
        draft_index: index,
        draft_type: draft.type ?? null,
        target: draft.target ?? null,
        decision: evaluation.decision,
        execution_allowed: evaluation.execution_allowed,
        tool_supervision_required: evaluation.tool_supervision_required,
        blockers: evaluation.blockers,
        blocker_count: evaluation.blockers.length,
        shadow_eligible: evaluation.decision === 'allow_execute',
        text_length: String(draft.draft_text ?? '').length
      });
    });
  }
  const blockers = draftEvaluations.flatMap((item) => item.blockers);
  const blockerCounts = blockers.reduce((counts, blocker) => {
    counts[blocker] = (counts[blocker] ?? 0) + 1;
    return counts;
  }, {});
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    policy_validation: validation,
    draft_count: draftEvaluations.length,
    shadow_eligible_count: draftEvaluations.filter((item) => item.shadow_eligible).length,
    tool_supervision_required_count: draftEvaluations.filter((item) => item.tool_supervision_required).length,
    execution_allowed_count: draftEvaluations.filter((item) => item.execution_allowed).length,
    blocker_counts: blockerCounts,
    by_type: draftEvaluations.reduce((counts, item) => {
      counts[item.draft_type ?? 'unknown'] = (counts[item.draft_type ?? 'unknown'] ?? 0) + 1;
      return counts;
    }, {}),
    samples: draftEvaluations.slice(0, 25),
    recommendation: 'Use this report to inspect which drafts tools would allow under active supervision.',
    safety: {
      policy_enabled: validation.policy.enabled === true,
      execution_allowed: false,
      tool_supervised_baseline_preserved: true
    }
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive unattended write shadow (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `drafts: ${report.draft_count}`,
    `shadow_eligible: ${report.shadow_eligible_count}`,
    `execution_allowed: ${report.execution_allowed_count}`,
    `tool_supervision_required: ${report.tool_supervision_required_count}`,
    '',
    'Blockers'
  ];
  for (const [blocker, count] of Object.entries(report.blocker_counts).sort()) {
    lines.push(`- ${blocker}: ${count}`);
  }
  lines.push('');
  lines.push(`recommendation: ${report.recommendation}`);
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
