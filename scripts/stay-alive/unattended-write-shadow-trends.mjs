#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    windows: [50, 100, 200],
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--windows') args.windows = argv[++i].split(',').map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value) && value > 0);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.windows.length === 0) throw new Error('--windows must include at least one positive integer');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/unattended-write-shadow-trends.mjs [options]

Options:
  --agent <id>          Agent id
  --runtime-root <dir>  Runtime agents directory
  --windows <a,b,c>     Recent run windows. Default: 50,100,200
  --json                Print JSON

Read-only long-window trend report over unattended-write shadow evaluations.
execution_allowed must remain zero.
`);
}

function runShadow(args, limit) {
  const result = spawnSync(process.execPath, [
    'scripts/stay-alive/unattended-write-shadow.mjs',
    '--agent', args.agent,
    '--runtime-root', args.runtimeRoot,
    '--limit', String(limit),
    '--json'
  ], { cwd: WORKSPACE, encoding: 'utf8', timeout: 120000 });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    limit,
    ok: result.status === 0,
    status: result.status,
    draft_count: parsed?.draft_count ?? 0,
    shadow_eligible_count: parsed?.shadow_eligible_count ?? 0,
    tool_supervision_required_count: parsed?.tool_supervision_required_count ?? 0,
    execution_allowed_count: parsed?.execution_allowed_count ?? null,
    blocker_counts: parsed?.blocker_counts ?? {},
    by_type: parsed?.by_type ?? {},
    stderr_preview: String(result.stderr ?? '').slice(0, 500)
  };
}

function buildReport(args) {
  const windows = args.windows.map((limit) => runShadow(args, limit));
  const latest = windows[windows.length - 1] ?? {};
  const anyExecutionAllowed = windows.some((item) => item.execution_allowed_count > 0);
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    windows,
    any_execution_allowed: anyExecutionAllowed,
    latest_risk_distribution: {
      blocker_counts: latest.blocker_counts ?? {},
      by_type: latest.by_type ?? {}
    },
    recommendation: anyExecutionAllowed
      ? 'Inspect allowed samples and keep tool-supervision gates tight.'
      : 'No samples are currently executable under tool supervision.',
    safety: {
      execution_allowed: false,
      policy_mode_changed: false
    }
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive unattended shadow trends (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `any_execution_allowed: ${report.any_execution_allowed ? 'yes' : 'no'}`,
    ''
  ];
  for (const item of report.windows) {
    lines.push(`- limit=${item.limit}: drafts=${item.draft_count} shadow_eligible=${item.shadow_eligible_count} execution_allowed=${item.execution_allowed_count}`);
  }
  lines.push('');
  lines.push(`recommendation: ${report.recommendation}`);
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
