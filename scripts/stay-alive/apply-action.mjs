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
    else if (arg === '--intention-id') args.intentionId = argv[++i];
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
  if (!args.intentionId) throw new Error('--intention-id is required');
  if (args.preflightDraftLimit === null) args.preflightDraftLimit = Math.max(args.preflightLimit, 200);
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/apply-action.mjs --run <run_id|path> --intention-id <id> [options]

Options:
  --agent <id>              Agent id. Default: badclaw
  --runtime-root <dir>      Runtime agents directory.
  --confirm-send SEND_DRAFT Actually send via BotLand. Omit for dry-run.
  --preflight-limit <n>     Recent run/audit window for the preflight gate. Default: 50
  --preflight-draft-limit <n>
                           Legacy draft lookup window for the preflight gate. Default: max(limit, 200)
  --preflight-history-limit <n>
                           Checkpoint history window for the preflight gate. Default: 3
  --help                    Show this help.

This is the intention/action path. It reads run.action_intentions[], evaluates
tool supervision, and records an action ledger entry without requiring a draft
approval state.
`);
}

function resolveRunPath(args) {
  if (args.run.includes('/') || args.run.endsWith('.json')) return path.resolve(args.run);
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
  return path.resolve(args.runtimeRoot) === path.resolve(defaultRoot) ? [] : ['--runtime-root', args.runtimeRoot];
}

function runPreflight(args) {
  const result = runCommand(process.execPath, [
    'scripts/stay-alive/preflight.mjs',
    '--agent', args.agent,
    '--limit', String(args.preflightLimit),
    '--draft-limit', String(args.preflightDraftLimit),
    '--history-limit', String(args.preflightHistoryLimit),
    '--no-checkpoint',
    '--json',
    ...runtimeRootArgs(args)
  ], 60000);
  const report = result.stdout_json;
  const verdict = report?.verdict ?? {};
  if (!result.ok || verdict.pass !== true) {
    const findings = Array.isArray(verdict.safety_findings) ? verdict.safety_findings.join(', ') : 'unknown';
    throw new Error(`Preflight gate failed: level=${verdict.level ?? 'unknown'}, findings=${findings}`);
  }
  return {
    ok: true,
    pass: verdict.pass,
    level: verdict.level,
    generated_at: report.generated_at ?? null,
    safety_findings: verdict.safety_findings ?? [],
    checkpoint_created: report.checkpoint_created?.checkpoint_id ?? null,
    operator_decision: report.operator_decision
      ? { level: report.operator_decision.level, reason: report.operator_decision.reason }
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
  return `action_apply_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function readPriorActions(actionsDir, intentionId) {
  if (!existsSync(actionsDir)) return [];
  return readdirSync(actionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(actionsDir, name))
    .map((file) => ({ ...JSON.parse(readFileSync(file, 'utf8')), action_path: path.relative(WORKSPACE, file) }))
    .filter((action) => action.action_intention_id === intentionId)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

function draftFromIntention(intention) {
  const proposed = intention.proposed_action ?? {};
  return {
    type: intention.action_type,
    ready_for_send: true,
    requires_confirmation: true,
    external_write: false,
    target: proposed.target ?? intention.target ?? null,
    source_event_id: proposed.source_event_id ?? intention.source?.event_id ?? null,
    source_message_id: proposed.source_message_id ?? intention.source?.message_id ?? null,
    source_actor_citizen_id: proposed.source_actor_citizen_id ?? intention.source?.actor_citizen_id ?? null,
    source_text_preview: proposed.source_text_preview ?? intention.source?.preview ?? null,
    draft_text: proposed.text ?? ''
  };
}

function plannerTraceSummary(run, intention) {
  const ref = intention?.planner_decision_trace_ref ?? null;
  const trace = run?.planner_decision_trace ?? run?.action_selection?.planner_decision_trace ?? null;
  const selectedCandidateId = trace?.selected_candidate_id ?? run?.action_selection?.selected_candidate_id ?? null;
  const candidateId = ref?.candidate_id ?? null;
  return {
    schema: 'stay_alive.planner_tool_supervision_explainability.v1',
    planner_trace_id: ref?.trace_id ?? trace?.trace_id ?? null,
    candidate_id: candidateId,
    planner_selected_this_intention: ref?.selected ?? (candidateId ? candidateId === selectedCandidateId : null),
    planner_selected_candidate_id: selectedCandidateId,
    planner_selected_type: trace?.selected_type ?? run?.action_selection?.selected_type ?? null,
    planner_reason: ref?.reason ?? run?.action_selection?.reason ?? null,
    choice_explanation: intention?.choice_explanation ?? null,
    outcome_influence: ref?.outcome_influence ?? null,
    decision_quality: ref?.decision_quality ?? null,
    tool_supervision_boundary: ref?.tool_supervision_boundary ?? {
      required: true,
      reason: 'Planner trace was not available; apply-action still requires active tool supervision.'
    },
    distinction: 'planner ranks intentions; tool supervision allows or blocks external execution'
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runPath = resolveRunPath(args);
  if (!existsSync(runPath)) throw new Error(`Run artifact not found: ${runPath}`);

  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  const lifeState = existsSync(lifeStatePath) ? JSON.parse(readFileSync(lifeStatePath, 'utf8')) : {};
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  const intention = Array.isArray(run.action_intentions)
    ? run.action_intentions.find((item) => item.intention_id === args.intentionId)
    : null;
  if (!intention) throw new Error(`Action intention not found: ${args.intentionId}`);
  if (intention.schema !== 'stay_alive.action_intention.v1') throw new Error(`Unsupported action intention schema: ${intention.schema}`);
  if (intention.human_review_required === true) throw new Error('Refusing intention with human_review_required=true');

  const draft = draftFromIntention(intention);
  if (!['direct_message_reply', 'public_moment', 'community_reply', 'friend_request_accept'].includes(draft.type)) {
    throw new Error(`Unsupported action type: ${draft.type}`);
  }
  if (!draft.draft_text) throw new Error('Action intention proposed_action.text is missing');

  const actionsDir = path.join(agentDir, 'actions');
  const priorActions = readPriorActions(actionsDir, intention.intention_id);
  const priorSuccessfulSend = priorActions.find((action) => !action.dry_run && action.result?.ok);
  if (priorSuccessfulSend) throw new Error(`Action intention already executed by ${priorSuccessfulSend.action_id}`);

  const preflightGate = runPreflight(args);
  const toolSupervisionDecision = evaluateUnattendedDraft({ lifeState, draft, preflightGate });
  const plannerToolSupervisionSummary = plannerTraceSummary(run, intention);
  const whoami = runBotlandIntent(BOTLAND_INTENTS.WHOAMI, {}, { timeoutMs: 10000, agent: args.agent });
  const expected = expectedCitizenId(run, lifeState);
  const actual = whoami.adapter?.normalized?.citizen_id ?? whoami.stdout_json?.citizen_id ?? null;
  if (!whoami.ok) throw new Error(`BotLand identity check failed: ${whoami.stderr_preview || whoami.stdout_preview}`);
  if (expected && actual !== expected) throw new Error(`BotLand identity mismatch: expected ${expected}, actual ${actual}`);

  const willSend = args.confirmSend === 'SEND_DRAFT';
  if (willSend && toolSupervisionDecision.execution_allowed !== true) {
    throw new Error(`Refusing to send: tool supervision did not allow execution (${toolSupervisionDecision.blockers.join(', ') || toolSupervisionDecision.decision})`);
  }

  const now = new Date();
  const legacyDraftIndex = Number.isInteger(intention.legacy_draft_index) ? intention.legacy_draft_index : null;
  const action = {
    action_id: actionId(now),
    created_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: !willSend,
    external_write: false,
    run_id: run.run_id,
    run_path: path.relative(WORKSPACE, runPath),
    action_intention_id: intention.intention_id,
    draft_index: legacyDraftIndex,
    legacy_draft_index: legacyDraftIndex,
    source_event_id: draft.source_event_id,
    source_message_id: draft.source_message_id,
    target: draft.target,
    action_text_sha256: sha256(draft.draft_text),
    draft_text_sha256: sha256(draft.draft_text),
    prior_action_count: priorActions.length,
    botland_identity: {
      expected_citizen_id: expected,
      actual_citizen_id: actual
    },
    preflight_gate: preflightGate,
    action_intention: intention,
    planner_tool_supervision_explainability: plannerToolSupervisionSummary,
    tool_supervision_decision: toolSupervisionDecision,
    legacy_unattended_policy_decision: toolSupervisionDecision,
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

  if (willSend) action.result = sendBotlandDraft(draft, { agent: args.agent });
  action.external_action_record = {
    schema: 'stay_alive.external_action_record.v1',
    action_type: draft.type,
    execution_attempted: willSend,
    execution_allowed: toolSupervisionDecision.execution_allowed === true,
    dry_run: !willSend,
    target: draft.target,
    source_event_id: draft.source_event_id ?? null,
    result_ok: action.result?.ok ?? null,
    planner_selected_this_intention: plannerToolSupervisionSummary.planner_selected_this_intention,
    planner_reason: plannerToolSupervisionSummary.planner_reason,
    tool_supervision_decision: toolSupervisionDecision.decision,
    blockers: toolSupervisionDecision.blockers ?? []
  };
  action.growth_integration = {
    schema: 'stay_alive.growth_integration.v1',
    status: willSend && action.result?.ok === true ? 'awaiting_post_send_inspection' : 'local_ledger_recorded',
    intended_memory_effect: intention.intended_effect ?? null,
    integration_note: willSend
      ? 'If delivery succeeds, inspect-send must integrate the effect before the next autonomous external action.'
      : 'Dry-run apply records the action intention and tool supervision decision without external delivery.'
  };

  mkdirSync(actionsDir, { recursive: true });
  const actionPath = path.join(actionsDir, `${action.action_id}.json`);
  writeFileSync(actionPath, `${JSON.stringify(action, null, 2)}\n`);

  console.log(JSON.stringify({
    action_id: action.action_id,
    dry_run: action.dry_run,
    action_path: path.relative(WORKSPACE, actionPath),
    run_id: run.run_id,
    action_intention_id: intention.intention_id,
    legacy_draft_index: legacyDraftIndex,
    target: draft.target,
    source_event_id: draft.source_event_id,
    botland_identity: action.botland_identity,
    preflight_gate: action.preflight_gate,
    action_intention: action.action_intention,
    planner_tool_supervision_explainability: action.planner_tool_supervision_explainability,
    tool_supervision_decision: action.tool_supervision_decision,
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
