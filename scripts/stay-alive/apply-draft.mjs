#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BOTLAND_INTENTS } from './botland-adapter/contract.mjs';
import { runBotlandIntent, sendBotlandDraft } from './botland-adapter/cli-driver.mjs';
import { evaluateUnattendedDraft } from './external-action-policy-lib.mjs';

const WORKSPACE = process.cwd();
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

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    draftIndex: 0,
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    confirmSend: null,
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
    else if (arg === '--confirm-send') args.confirmSend = argv[++i];
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
  console.log(`Usage: node scripts/stay-alive/apply-draft.mjs --run <run_id|path> [options]

Options:
  --agent <id>              Agent id. Default: badclaw
  --draft-index <n>         Draft index in run.drafts. Default: 0
  --runtime-root <dir>      Runtime agents directory.
  --confirm-send SEND_DRAFT Actually send via BotLand. Omit for dry-run.
  --preflight-limit <n>     Recent run/audit window for the preflight gate. Default: 50
  --preflight-draft-limit <n>
                           Draft lookup window for the preflight gate. Default: max(limit, 200)
  --preflight-history-limit <n>
                           Checkpoint history window for the preflight gate. Default: 3
  --help                    Show this help.

Before recording a dry-run action or sending, this command runs the read-only
preflight gate with --no-checkpoint and refuses to continue unless it passes.
`);
}

function resolveRunPath(args) {
  if (args.run.includes('/') || args.run.endsWith('.json')) {
    return path.resolve(args.run);
  }
  return path.join(args.runtimeRoot, args.agent, 'runs', `${args.run}.json`);
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

function expectedCitizenId(run, lifeState) {
  const identity = (run.observations ?? []).find((item) => item.topic === 'botland_identity');
  return identity?.expected_citizen_id ?? lifeState.botland?.citizen_id ?? null;
}

function actionId(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `draft_apply_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function draftKey(runId, draftIndex) {
  return `${runId}:${draftIndex}`;
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runPath = args.run === 'latest-with-draft' ? latestRunWithDraft(args) : resolveRunPath(args);
  if (!runPath || !existsSync(runPath)) throw new Error(`Run artifact not found: ${runPath ?? args.run}`);

  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  const lifeState = existsSync(lifeStatePath) ? JSON.parse(readFileSync(lifeStatePath, 'utf8')) : {};
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  const draft = Array.isArray(run.drafts) ? run.drafts[args.draftIndex] : null;
  if (!draft) throw new Error(`Draft index ${args.draftIndex} not found in ${run.run_id}`);
  if (!['direct_message_reply', 'public_moment', 'community_reply', 'friend_request_accept'].includes(draft.type)) {
    throw new Error(`Unsupported draft type: ${draft.type}`);
  }
  if (draft.ready_for_send !== true) {
    throw new Error('Refusing to apply a draft that is not marked ready_for_send=true');
  }
  if (!draft.requires_confirmation) throw new Error('Refusing to apply a draft that does not require confirmation');
  if (draft.external_write) throw new Error('Refusing to apply a draft already marked as external_write');
  if (draft.type === 'direct_message_reply' && !draft.target?.citizen_id) {
    throw new Error('Draft target.citizen_id is missing');
  }
  if (draft.type === 'public_moment' && draft.target?.visibility !== 'public') {
    throw new Error('Public moment draft target.visibility must be public');
  }
  if (draft.type === 'community_reply' && !draft.target?.post_id) {
    throw new Error('Community reply draft target.post_id is missing');
  }
  if (draft.type === 'friend_request_accept' && !draft.target?.request_id) {
    throw new Error('Friend request accept draft target.request_id is missing');
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
  const priorApproval = priorActions.findLast
    ? priorActions.findLast((action) => action.status === 'approved')
    : [...priorActions].reverse().find((action) => action.status === 'approved');
  const draftTextSha256 = sha256(draft.draft_text);
  const preflightGate = runPreflight(args);
  const toolSupervisionDecision = evaluateUnattendedDraft({ lifeState, draft, preflightGate });
  const actionIntention = Array.isArray(run.action_intentions)
    ? run.action_intentions.find((item) => (item.legacy_draft_index ?? item.draft_index) === args.draftIndex) ?? null
    : null;

  const whoami = runBotlandIntent(BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000, agent: args.agent });
  const expected = expectedCitizenId(run, lifeState);
  const actual = whoami.adapter?.normalized?.citizen_id ?? whoami.stdout_json?.citizen_id ?? null;
  if (!whoami.ok) throw new Error(`BotLand identity check failed: ${whoami.stderr_preview || whoami.stdout_preview}`);
  if (expected && actual !== expected) {
    throw new Error(`BotLand identity mismatch: expected ${expected}, actual ${actual}`);
  }
  const now = new Date();

  const willSend = args.confirmSend === 'SEND_DRAFT';
  if (willSend && toolSupervisionDecision.execution_allowed !== true) {
    throw new Error(`Refusing to send: tool supervision did not allow execution (${toolSupervisionDecision.blockers.join(', ') || toolSupervisionDecision.decision})`);
  }
  if (willSend && priorApproval && priorApproval.draft_text_sha256 !== draftTextSha256) {
    throw new Error(`Refusing to send: legacy approval hash mismatch for this draft (approved ${priorApproval.draft_text_sha256 ?? 'missing'}, current ${draftTextSha256})`);
  }
  const action = {
    action_id: actionId(now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: !willSend,
    external_write: false,
    run_id: run.run_id,
    run_path: path.relative(WORKSPACE, runPath),
    draft_index: args.draftIndex,
    source_event_id: draft.source_event_id,
    source_message_id: draft.source_message_id,
    target: draft.target,
    draft_text_sha256: draftTextSha256,
    prior_action_count: priorActions.length,
    legacy_prior_approval: priorApproval
      ? {
          action_id: priorApproval.action_id,
          action_path: priorApproval.action_path,
          created_at: priorApproval.created_at,
          approved_by: priorApproval.approved_by ?? null
        }
      : null,
    botland_identity: {
      expected_citizen_id: expected,
      actual_citizen_id: actual
    },
    preflight_gate: preflightGate,
    action_intention: actionIntention,
    tool_supervision_decision: toolSupervisionDecision,
    unattended_policy_decision: toolSupervisionDecision,
    command: willSend
      ? draft.type === 'public_moment'
        ? 'botland moments post'
        : draft.type === 'community_reply'
          ? 'botland communities reply'
          : draft.type === 'friend_request_accept'
            ? 'botland friends requests accept'
          : 'botland send'
      : null,
    botland_adapter: {
      driver: 'cli',
      identity_intent: BOTLAND_INTENTS.WHOAMI,
      send_intent: draft.type === 'public_moment'
        ? BOTLAND_INTENTS.MOMENT_POST
        : draft.type === 'community_reply'
          ? BOTLAND_INTENTS.COMMUNITY_REPLY
          : draft.type === 'friend_request_accept'
            ? BOTLAND_INTENTS.FRIEND_REQUEST_ACCEPT
          : BOTLAND_INTENTS.DIRECT_MESSAGE_SEND
    },
    result: null
  };

  if (willSend) {
    action.result = sendBotlandDraft(draft, { agent: args.agent });
  }
  action.external_action_record = {
    schema: 'stay_alive.external_action_record.v1',
    action_type: draft.type,
    execution_attempted: willSend,
    execution_allowed: toolSupervisionDecision.execution_allowed === true,
    dry_run: !willSend,
    target: draft.target,
    source_event_id: draft.source_event_id ?? null,
    result_ok: action.result?.ok ?? null,
    tool_supervision_decision: toolSupervisionDecision.decision,
    blockers: toolSupervisionDecision.blockers ?? []
  };
  action.growth_integration = {
    schema: 'stay_alive.growth_integration.v1',
    status: willSend && action.result?.ok === true ? 'awaiting_post_send_inspection' : 'local_ledger_recorded',
    intended_memory_effect: actionIntention?.intended_effect ?? null,
    integration_note: willSend
      ? 'If delivery succeeds, inspect-send must integrate the effect before the next autonomous external action.'
      : 'Dry-run apply records the autonomous intention and tool supervision decision without external delivery.'
  };

  mkdirSync(actionsDir, { recursive: true });
  const actionPath = path.join(actionsDir, `${action.action_id}.json`);
  writeFileSync(actionPath, `${JSON.stringify(action, null, 2)}\n`);

  console.log(JSON.stringify({
    action_id: action.action_id,
    dry_run: action.dry_run,
    action_path: path.relative(WORKSPACE, actionPath),
    run_id: run.run_id,
    draft_index: args.draftIndex,
    target: draft.target,
    source_event_id: draft.source_event_id,
    botland_identity: action.botland_identity,
    preflight_gate: action.preflight_gate,
    action_intention: action.action_intention,
    tool_supervision_decision: action.tool_supervision_decision,
    unattended_policy_decision: action.unattended_policy_decision,
    external_action_record: action.external_action_record,
    growth_integration: action.growth_integration,
    would_send_text: willSend ? null : draft.draft_text,
    send_result: action.result
      ? {
          ok: action.result.ok,
          status: action.result.status,
          stdout_json: action.result.stdout_json,
          stderr_preview: action.result.stderr_preview
        }
      : null
  }, null, 2));

  if (action.result && !action.result.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
