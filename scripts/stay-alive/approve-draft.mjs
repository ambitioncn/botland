#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    draftIndex: 0,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    approvedBy: 'tool-supervision',
    note: null,
    preflightLimit: 50,
    preflightDraftLimit: null,
    preflightHistoryLimit: 3
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--run') args.run = argv[++i];
    else if (arg === '--draft-index') args.draftIndex = Number.parseInt(argv[++i], 10);
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--approved-by') args.approvedBy = argv[++i];
    else if (arg === '--note') args.note = argv[++i];
    else if (arg === '--preflight-limit') args.preflightLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--preflight-draft-limit') args.preflightDraftLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--preflight-history-limit') args.preflightHistoryLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.run) throw new Error('--run is required');
  if (!Number.isInteger(args.draftIndex) || args.draftIndex < 0) {
    throw new Error('--draft-index must be a non-negative integer');
  }
  if (!Number.isInteger(args.preflightLimit) || args.preflightLimit < 1) {
    throw new Error('--preflight-limit must be a positive integer');
  }
  if (args.preflightDraftLimit === null) {
    args.preflightDraftLimit = Math.max(args.preflightLimit, 200);
  }
  if (!Number.isInteger(args.preflightDraftLimit) || args.preflightDraftLimit < 1) {
    throw new Error('--preflight-draft-limit must be a positive integer');
  }
  if (!Number.isInteger(args.preflightHistoryLimit) || args.preflightHistoryLimit < 1) {
    throw new Error('--preflight-history-limit must be a positive integer');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/approve-draft.mjs --run <run_id|path> [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --draft-index <n>     Draft index in run.drafts. Default: 0
  --runtime-root <dir>  Runtime agents directory.
  --approved-by <name>  Approver label stored in the local artifact.
  --note <text>         Optional operator note.
  --preflight-limit <n> Recent run/audit window for the preflight gate. Default: 50
  --preflight-draft-limit <n>
                       Draft lookup window for the preflight gate. Default: max(limit, 200)
  --preflight-history-limit <n>
                       Checkpoint history window for the preflight gate. Default: 3
  --help                Show this help.

Before recording the local approval artifact, this command runs the read-only
preflight gate with --no-checkpoint and refuses to continue unless it passes.
`);
}

const DEFAULT_COMMAND_PATHS = [
  path.join(process.env.HOME ?? '', '.npm-global', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
].filter(Boolean);

function commandEnv() {
  const existingPath = process.env.PATH ?? '';
  const pathParts = existingPath.split(':').filter(Boolean);
  return {
    ...process.env,
    PATH: [...DEFAULT_COMMAND_PATHS, ...pathParts].filter((item, index, arr) => arr.indexOf(item) === index).join(':')
  };
}

function runCommand(command, commandArgs, timeoutMs = 10000) {
  const result = spawnSync(command, commandArgs, {
    cwd: WORKSPACE,
    env: commandEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
  const stdout = result.stdout ? result.stdout.trim() : '';
  const stderr = result.stderr ? result.stderr.trim() : '';
  let stdoutJson = null;
  if (stdout) {
    try {
      stdoutJson = JSON.parse(stdout);
    } catch {
      stdoutJson = null;
    }
  }
  return {
    command: [command, ...commandArgs].join(' '),
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout_json: stdoutJson,
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function runtimeRootArgs(args) {
  const defaultRoot = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot)
    ? []
    : ['--runtime-root', args.runtimeRoot];
}

function runPreflight(args) {
  const result = runCommand(process.execPath, [
    'scripts/stay-alive/preflight.mjs',
    '--agent',
    args.agent,
    '--limit',
    String(args.preflightLimit),
    '--draft-limit',
    String(args.preflightDraftLimit),
    '--history-limit',
    String(args.preflightHistoryLimit),
    '--no-checkpoint',
    '--json',
    ...runtimeRootArgs(args)
  ], 60000);

  const report = result.stdout_json;
  const verdict = report?.verdict ?? {};
  if (!result.ok || verdict.pass !== true) {
    const findings = Array.isArray(verdict.safety_findings) ? verdict.safety_findings.join(', ') : 'unknown';
    const level = verdict.level ?? 'unknown';
    throw new Error(`Preflight gate failed: level=${level}, findings=${findings}`);
  }

  return {
    ok: true,
    pass: verdict.pass,
    level: verdict.level,
    generated_at: report.generated_at ?? null,
    safety_findings: verdict.safety_findings ?? [],
    checkpoint_created: report.checkpoint_created?.checkpoint_id ?? null,
    audit: report.audit
      ? {
          external_action_count: report.audit.external_action_count,
          successful_send_count: report.audit.successful_send_count,
          external_write_action_count: report.audit.external_write_action_count,
          checkpoint_external_evidence_count: report.audit.checkpoint_external_evidence_count,
          checkpoint_failed_audit_count: report.audit.checkpoint_failed_audit_count
        }
      : null,
    control_audit: report.control_audit
      ? {
          pass: report.control_audit.pass,
          level: report.control_audit.level,
          error_count: report.control_audit.error_count,
          warning_count: report.control_audit.warning_count
        }
      : null,
    operator_decision: report.operator_decision
      ? {
          level: report.operator_decision.level,
          reason: report.operator_decision.reason
        }
      : null
  };
}

function resolveRunPath(args) {
  if (args.run.includes('/') || args.run.endsWith('.json')) {
    return path.resolve(args.run);
  }
  return path.join(args.runtimeRoot, args.agent, 'runs', `${args.run}.json`);
}

function actionId(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `draft_approve_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function draftKey(runId, draftIndex) {
  return `${runId}:${draftIndex}`;
}

function readPriorActions(actionsDir, runId, draftIndex) {
  if (!existsSync(actionsDir)) return [];

  return readdirSync(actionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(actionsDir, name))
    .map((file) => {
      const action = JSON.parse(readFileSync(file, 'utf8'));
      return { ...action, action_path: path.relative(WORKSPACE, file) };
    })
    .filter((action) => draftKey(action.run_id, action.draft_index) === draftKey(runId, draftIndex))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

function latestRunWithDraft(args) {
  const runsDir = path.join(args.runtimeRoot, args.agent, 'runs');
  if (!existsSync(runsDir)) return null;
  const files = readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse();
  return files.find((file) => {
    const run = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(run.drafts) && run.drafts.length > 0;
  }) ?? null;
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function preview(text, limit = 160) {
  if (!text) return '';
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runPath = args.run === 'latest-with-draft' ? latestRunWithDraft(args) : resolveRunPath(args);
  if (!runPath || !existsSync(runPath)) throw new Error(`Run artifact not found: ${runPath ?? args.run}`);

  const agentDir = path.join(args.runtimeRoot, args.agent);
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  const draft = Array.isArray(run.drafts) ? run.drafts[args.draftIndex] : null;
  if (!draft) throw new Error(`Draft index ${args.draftIndex} not found in ${run.run_id}`);
  if (draft.ready_for_send !== true) {
    throw new Error('Refusing to approve a draft that is not marked ready_for_send=true');
  }
  if (!draft.requires_confirmation) {
    throw new Error('Refusing to approve a draft that does not require confirmation');
  }
  if (draft.external_write) {
    throw new Error('Refusing to approve a draft already marked as external_write');
  }
  if (!draft.draft_text) throw new Error('Draft text is missing');

  const actionsDir = path.join(agentDir, 'actions');
  const priorActions = readPriorActions(actionsDir, run.run_id, args.draftIndex);
  const priorSuccessfulSend = priorActions.find((action) => !action.dry_run && action.result?.ok);
  if (priorSuccessfulSend) {
    throw new Error(`Draft already sent by ${priorSuccessfulSend.action_id} (${priorSuccessfulSend.action_path})`);
  }
  const priorDismissal = priorActions.find((action) => action.status === 'dismissed');
  if (priorDismissal) {
    throw new Error(`Draft already dismissed by ${priorDismissal.action_id} (${priorDismissal.action_path})`);
  }
  const priorApproval = priorActions.find((action) => action.status === 'approved');
  if (priorApproval) {
    throw new Error(`Draft already approved by ${priorApproval.action_id} (${priorApproval.action_path})`);
  }
  const preflightGate = runPreflight(args);
  const now = new Date();

  const action = {
    action_id: actionId(now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: true,
    status: 'approved',
    run_id: run.run_id,
    run_path: path.relative(WORKSPACE, runPath),
    draft_index: args.draftIndex,
    source_event_id: draft.source_event_id ?? null,
    source_message_id: draft.source_message_id ?? null,
    target: draft.target ?? null,
    approved_by: args.approvedBy,
    note: args.note,
    draft_text_sha256: sha256(draft.draft_text),
    draft_text_preview: preview(draft.draft_text),
    prior_action_count: priorActions.length,
    preflight_gate: preflightGate,
    result: {
      ok: true,
      external_write: false
    }
  };

  mkdirSync(actionsDir, { recursive: true });
  const actionPath = path.join(actionsDir, `${action.action_id}.json`);
  writeFileSync(actionPath, `${JSON.stringify(action, null, 2)}\n`);

  console.log(JSON.stringify({
    action_id: action.action_id,
    status: action.status,
    action_path: path.relative(WORKSPACE, actionPath),
    run_id: run.run_id,
    draft_index: args.draftIndex,
    source_event_id: action.source_event_id,
    draft_text_sha256: action.draft_text_sha256,
    preflight_gate: action.preflight_gate,
    external_write: false
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
