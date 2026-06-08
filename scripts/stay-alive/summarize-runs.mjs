#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    limit: 10,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents')
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/summarize-runs.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --limit <n>           Number of recent runs to summarize. Default: 10
  --runtime-root <dir>  Runtime agents directory.
  --help                Show this help.
`);
}

function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function summarizeRun(file) {
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const failedChecks = (run.inputs?.botland_checks ?? []).filter((check) => !check.ok);
  const identity = (run.observations ?? []).find((item) => item.topic === 'botland_identity') ?? null;
  const drafts = Array.isArray(run.drafts) ? run.drafts : [];
  const confirmationDrafts = drafts.filter((draft) => draft.requires_confirmation);

  return {
    run_id: run.run_id,
    created_at: run.created_at,
    cycle: run.cycle,
    dry_run: run.dry_run,
    botland_checks_ok: failedChecks.length === 0,
    failed_botland_checks: failedChecks.map((check) => check.command),
    identity_status: identity
      ? {
          severity: identity.severity,
          expected_citizen_id: identity.expected_citizen_id ?? null,
          actual_citizen_id: identity.actual_citizen_id ?? null
        }
      : null,
    chosen_action_type: run.chosen_action?.type ?? null,
    requires_confirmation: run.chosen_action?.requires_confirmation ?? false,
    draft_count: drafts.length,
    confirmation_draft_count: confirmationDrafts.length,
    policy_gate_reason: run.policy_gate?.reason ?? null,
    external_action_count: Array.isArray(run.external_actions) ? run.external_actions.length : 0,
    next_check_after: run.next_check_after
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const runsDir = path.join(agentDir, 'runs');
  const daemonStatePath = path.join(agentDir, 'daemon_state.json');

  if (!existsSync(runsDir)) {
    throw new Error(`No runs directory found: ${runsDir}`);
  }

  const runFiles = readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, args.limit);

  const runs = runFiles.map(summarizeRun);
  const daemonState = readJsonIfExists(daemonStatePath, null);
  const failedRuns = runs.filter((run) => (
    !run.botland_checks_ok
    || run.external_action_count > 0
    || ['warning', 'error'].includes(run.identity_status?.severity)
  ));

  console.log(JSON.stringify({
    agent_id: args.agent,
    run_count_summarized: runs.length,
    failed_or_attention_run_count: failedRuns.length,
    daemon_state: daemonState
      ? {
          run_count: daemonState.run_count ?? 0,
          last_run_id: daemonState.last_run_id ?? null,
          last_run_at_by_cycle: daemonState.last_run_at_by_cycle ?? {},
          next_check_after_by_cycle: daemonState.next_check_after_by_cycle ?? {},
          processed_event_count: Array.isArray(daemonState.processed_event_ids)
            ? daemonState.processed_event_ids.length
            : 0,
          last_seen_event_id: daemonState.last_seen_event_id ?? null
        }
      : null,
    runs
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
