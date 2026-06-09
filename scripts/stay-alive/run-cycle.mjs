#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildActionCandidates, buildOutcomePlanningContext, selectActionCandidate } from './action-planner.mjs';
import { BOTLAND_INTENTS } from './botland-adapter/contract.mjs';
import { collectBotlandForCycle, runBotlandIntentWithRetry } from './botland-adapter/cli-driver.mjs';
import { buildDurableBecomingContext } from './durable-becoming-lib.mjs';
import { buildGrowthApplyContext } from './growth-apply-lib.mjs';
import { buildGrowthContinuityContext } from './growth-continuity-lib.mjs';
import { loadActivePlannerPatchContext, validatePlannerPatches } from './planner-patch-lib.mjs';
import {
  buildRelationshipGraph,
  relationshipGraphMemoryUpdate,
  relationshipGraphRelationshipUpdates
} from './relationship-graph.mjs';
import { retrieveMemories } from './retrieve-memory.mjs';
import { buildSelfDiscoveryGrowthContext } from './self-discovery-growth-lib.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
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
    cycle: 'reflect',
    dryRun: true,
    botland: true,
    writeState: false,
    writeDaemonState: false,
    memory: true,
    memoryBackend: 'auto',
    memoryLimit: 5,
    runtimeRoot: DEFAULT_RUNTIME
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--cycle') args.cycle = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--state') args.statePath = path.resolve(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-dry-run') args.dryRun = false;
    else if (arg === '--no-botland') args.botland = false;
    else if (arg === '--no-memory') args.memory = false;
    else if (arg === '--memory-backend') args.memoryBackend = argv[++i];
    else if (arg === '--memory-limit') args.memoryLimit = Number.parseInt(argv[++i], 10);
    else if (arg === '--write-state') args.writeState = true;
    else if (arg === '--daemon-state') args.daemonStatePath = path.resolve(argv[++i]);
    else if (arg === '--write-daemon-state') args.writeDaemonState = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['light', 'social', 'community', 'reflect', 'integrate', 'agency'].includes(args.cycle)) {
    throw new Error(`Unsupported cycle "${args.cycle}". Use light, social, community, reflect, integrate, or agency.`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/run-cycle.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --cycle <type>        light | social | community | reflect | integrate | agency. Default: reflect
  --runtime-root <dir>  Runtime agents directory.
  --state <file>        Explicit life_state.json path.
  --dry-run             Produce local run artifact only. Default.
  --no-botland          Skip BotLand read-only probes.
  --no-memory           Skip local memory backend retrieval.
  --memory-backend <b>  auto | lancedb | json-local. Default: auto.
  --memory-limit <n>    Max memories to retrieve. Default: 5.
  --write-state         Update reflection fields in life_state.json.
  --daemon-state <file> Explicit daemon_state.json path.
  --write-daemon-state  Update daemon_state.json run/cooldown metadata.
  --help                Show this help.
`);
}

function buildMemoryQuery(lifeState, cycle, stateSummary) {
  const relationships = Array.isArray(lifeState.relationships)
    ? lifeState.relationships.map((relationship) => relationship.name ?? relationship.target_id).filter(Boolean).slice(0, 5)
    : [];
  const desires = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires.filter((desire) => desire.status !== 'closed').map((desire) => desire.text).slice(0, 3)
    : [];
  return [
    `stay-alive ${cycle}`,
    lifeState.agent_id,
    lifeState.self_model?.name,
    lifeState.life_theme,
    `relationships ${relationships.join(' ')}`,
    `desires ${desires.join(' ')}`,
    `known relationships ${stateSummary.known_relationships}`,
    `open commitments ${stateSummary.open_commitments}`
  ].filter(Boolean).join(' ');
}

async function loadRelevantMemory(args, lifeState, cycle, stateSummary) {
  if (!args.memory) {
    return {
      read_only: true,
      enabled: false,
      memory_count: 0,
      memories: [],
      query: null
    };
  }
  const query = buildMemoryQuery(lifeState, cycle, stateSummary);
  try {
    const report = await retrieveMemories({
      agent: args.agent,
      runtimeRoot: args.runtimeRoot,
      backend: args.memoryBackend,
      limit: args.memoryLimit,
      query,
      lancedbPath: null,
      jsonStoreDir: null
    });
    return {
      ...report,
      enabled: true,
      ok: true
    };
  } catch (error) {
    return {
      read_only: true,
      enabled: true,
      ok: false,
      generated_at: new Date().toISOString(),
      agent_id: args.agent,
      query,
      memory_count: 0,
      memories: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function memoryContextSummary(memoryRetrieval) {
  if (!memoryRetrieval?.enabled) return 'Memory retrieval was disabled for this run.';
  if (memoryRetrieval.ok === false) return `Memory retrieval failed read-only: ${memoryRetrieval.error}`;
  if ((memoryRetrieval.memory_count ?? 0) === 0) return 'Memory retrieval returned no matching long-term memories.';
  return `Retrieved ${memoryRetrieval.memory_count} relevant long-term memor${memoryRetrieval.memory_count === 1 ? 'y' : 'ies'} from ${memoryRetrieval.backend?.selected_backend ?? 'memory backend'}.`;
}

function isoCompact(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${ms}`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return readJson(file);
}

function readJsonFileOrNull(file) {
  try {
    return readJson(file);
  } catch (error) {
    return {
      _read_error: error instanceof Error ? error.message : String(error),
      _path: path.relative(WORKSPACE, file)
    };
  }
}

function listAppliedLedgers(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse()
    .map(readJsonFileOrNull)
    .filter((item) => !item._read_error);
}

function runCommand(command, args, timeoutMs = 5000) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: WORKSPACE,
    env: commandEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });

  const stdout = result.stdout ? result.stdout.trim() : '';
  const stderr = result.stderr ? result.stderr.trim() : '';
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }

  return {
    command: [command, ...args].join(' '),
    started_at: startedAt,
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout_json: parsed,
    stdout_preview: stdout.slice(0, 500),
    stderr_preview: stderr.slice(0, 500)
  };
}

function runCommandWithRetry(command, args, options = {}) {
  const attempts = options.attempts ?? 1;
  const timeoutMs = options.timeoutMs ?? 5000;
  let lastResult = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runCommand(command, args, timeoutMs);
    lastResult = {
      ...result,
      attempt,
      max_attempts: attempts,
      timeout_ms: timeoutMs
    };
    if (result.ok) return lastResult;
  }

  return lastResult;
}

function collectBotland(cycle, lifeState = null) {
  return collectBotlandForCycle(cycle, { lifeState }).checks;
}

function summarizeState(lifeState) {
  const commitments = Array.isArray(lifeState.commitments) ? lifeState.commitments : [];
  const desires = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  return {
    active_desires: desires.filter((item) => item.status !== 'closed').length,
    open_commitments: commitments.filter((item) => isOpenCommitmentStatus(item.status ?? 'open')).length,
    known_relationships: relationships.length,
    last_full_reflection_at: lifeState.reflection?.last_full_reflection_at ?? null
  };
}

function defaultDaemonState(agentId) {
  return {
    schema_version: 1,
    agent_id: agentId,
    updated_at: null,
    run_count: 0,
    last_run_id: null,
    last_run_at_by_cycle: {},
    next_check_after_by_cycle: {},
    cooldowns: {
      external_write_until: null,
      public_post_until: null,
      proactive_dm_until: null
    },
    processed_event_ids: [],
    last_seen_event_id: null
  };
}

function summarizeDaemonState(daemonState) {
  return {
    run_count: daemonState.run_count ?? 0,
    last_run_id: daemonState.last_run_id ?? null,
    last_run_at_by_cycle: daemonState.last_run_at_by_cycle ?? {},
    next_check_after_by_cycle: daemonState.next_check_after_by_cycle ?? {},
    cooldowns: daemonState.cooldowns ?? {},
    processed_event_count: Array.isArray(daemonState.processed_event_ids)
      ? daemonState.processed_event_ids.length
      : 0,
    last_seen_event_id: daemonState.last_seen_event_id ?? null
  };
}

function listRecentRunFiles(runsDir, currentRunId, limit = 50) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== `${currentRunId}.json`)
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, limit);
}

function listPrivateGrowthJournals(agentDir, limit = 30) {
  const journalDir = path.join(agentDir, 'agency_journal');
  if (!existsSync(journalDir)) return [];
  return readdirSync(journalDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(journalDir, name))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(readJsonFileOrNull)
    .filter((item) => item?.schema === 'stay_alive.private_growth_journal.v1');
}

function listRecentOutcomeFiles(agentDir, limit = 50) {
  const outcomesDir = path.join(agentDir, 'action_outcomes');
  if (!existsSync(outcomesDir)) return [];
  return readdirSync(outcomesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(outcomesDir, name))
    .sort()
    .reverse()
    .slice(0, limit);
}

function summarizeRecentRun(run) {
  const failedChecks = Array.isArray(run.inputs?.botland_checks)
    ? run.inputs.botland_checks.filter((check) => !check.ok)
    : [];
  const observations = Array.isArray(run.observations) ? run.observations : [];
  const identity = observations.find((item) => item.topic === 'botland_identity') ?? null;
  const drafts = Array.isArray(run.drafts) ? run.drafts : [];
  const memoryUpdates = Array.isArray(run.memory_updates) ? run.memory_updates : [];
  const stateUpdates = Array.isArray(run.state_updates) ? run.state_updates : [];

  return {
    run_id: run.run_id ?? null,
    created_at: run.created_at ?? null,
    cycle: run.cycle ?? null,
    dry_run: run.dry_run ?? null,
    health: {
      botland_checks_ok: failedChecks.length === 0,
      failed_botland_checks: failedChecks.map((check) => check.command),
      identity_severity: identity?.severity ?? null,
      external_action_count: Array.isArray(run.external_actions) ? run.external_actions.length : null
    },
    action: {
      type: run.chosen_action?.type ?? null,
      requires_confirmation: run.chosen_action?.requires_confirmation ?? false,
      summary: run.chosen_action?.summary ?? null
    },
    drafts: {
      count: drafts.length,
      ready_count: drafts.filter((draft) => draft.ready_for_send === true).length,
      confirmation_count: drafts.filter((draft) => draft.requires_confirmation === true).length
    },
    integration: {
      memory_update_count: memoryUpdates.length,
      state_update_count: stateUpdates.length
    },
    next_check_after: run.next_check_after ?? null
  };
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item) ?? 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function describeRunWindow(runs) {
  const chronological = [...runs].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  return {
    run_count: runs.length,
    first_run_at: chronological[0]?.created_at ?? null,
    latest_run_at: chronological.at(-1)?.created_at ?? null,
    cycle_counts: countBy(runs, (run) => run.cycle),
    chosen_action_counts: countBy(runs, (run) => run.action?.type ?? 'none'),
    draft_count: runs.reduce((sum, run) => sum + (run.drafts?.count ?? 0), 0),
    ready_draft_count: runs.reduce((sum, run) => sum + (run.drafts?.ready_count ?? 0), 0),
    confirmation_draft_count: runs.reduce((sum, run) => sum + (run.drafts?.confirmation_count ?? 0), 0),
    external_action_count: runs.reduce((sum, run) => sum + (run.health?.external_action_count ?? 0), 0),
    failed_botland_check_count: runs.reduce((sum, run) => sum + (run.health?.failed_botland_checks?.length ?? 0), 0),
    identity_attention_count: runs.filter((run) => ['warning', 'error'].includes(run.health?.identity_severity)).length
  };
}

function summarizeActionOutcome(outcome) {
  const proposalCounts = outcome.growth_integration?.proposal_counts ?? {
    memory_updates: Array.isArray(outcome.memory_updates) ? outcome.memory_updates.length : 0,
    relationship_updates: Array.isArray(outcome.relationship_updates) ? outcome.relationship_updates.length : 0,
    commitment_updates: Array.isArray(outcome.commitment_updates) ? outcome.commitment_updates.length : 0,
    desire_updates: Array.isArray(outcome.desire_updates) ? outcome.desire_updates.length : 0
  };
  return {
    outcome_id: outcome.outcome_id ?? null,
    created_at: outcome.created_at ?? null,
    send_action_id: outcome.send_action_id ?? null,
    action_type: outcome.action_type ?? null,
    outcome_status: outcome.outcome_status ?? null,
    feedback_count: outcome.observation?.feedback_count ?? 0,
    feedback_signal_strength: outcome.observation?.feedback_interpretation?.signal_strength ?? null,
    feedback_author_count: outcome.observation?.feedback_interpretation?.feedback_author_count ?? outcome.observation?.feedback_authors?.length ?? 0,
    action_quality_rating: outcome.action_quality_score?.rating ?? null,
    action_quality_overall: outcome.action_quality_score?.overall ?? null,
    action_quality_axes: outcome.action_quality_score?.axes ?? null,
    action_quality_hints: outcome.action_quality_score?.improvement_hints ?? [],
    growth_integration_status: outcome.growth_integration?.integration_status ?? null,
    relationship_learning_confidence: outcome.growth_integration?.relationship_learning_v1?.confidence ?? null,
    relationship_learning_summary: outcome.growth_integration?.relationship_learning_v1?.summary ?? outcome.growth_integration?.relationship_learning ?? null,
    desire_evolution_change: outcome.growth_integration?.desire_evolution_v1?.suggested_change ?? null,
    desire_evolution_primary_desire_id: outcome.growth_integration?.desire_evolution_v1?.primary_desire_id ?? null,
    self_model_learning_signal: outcome.growth_integration?.self_model_learning_v1?.expression_signal ?? null,
    self_model_learning_attention: outcome.growth_integration?.self_model_learning_v1?.suggested_self_model_attention ?? null,
    proposal_counts: proposalCounts,
    recommended_next: outcome.growth_integration?.recommended_next ?? outcome.observation?.feedback_interpretation?.recommended_next ?? null
  };
}

function describeOutcomeWindow(outcomes) {
  return {
    outcome_count: outcomes.length,
    status_counts: countBy(outcomes, (outcome) => outcome.outcome_status),
    action_type_counts: countBy(outcomes, (outcome) => outcome.action_type),
    quality_rating_counts: countBy(outcomes, (outcome) => outcome.action_quality_rating ?? 'unscored'),
    desire_evolution_counts: countBy(outcomes, (outcome) => outcome.desire_evolution_change ?? 'none'),
    relationship_learning_counts: countBy(outcomes, (outcome) => outcome.relationship_learning_confidence ?? 'none'),
    self_model_learning_counts: countBy(outcomes, (outcome) => outcome.self_model_learning_signal ?? 'none'),
    feedback_received_count: outcomes.filter((outcome) => outcome.outcome_status === 'feedback_received').length,
    stale_count: outcomes.filter((outcome) => ['stale_pending_close', 'stale_closed'].includes(outcome.outcome_status)).length,
    proposal_counts: outcomes.reduce((acc, outcome) => {
      const counts = outcome.proposal_counts ?? {};
      acc.memory_updates += counts.memory_updates ?? 0;
      acc.relationship_updates += counts.relationship_updates ?? 0;
      acc.commitment_updates += counts.commitment_updates ?? 0;
      acc.desire_updates += counts.desire_updates ?? 0;
      return acc;
    }, {
      memory_updates: 0,
      relationship_updates: 0,
      commitment_updates: 0,
      desire_updates: 0
    })
  };
}

function buildIntegrationSummary(lifeState, daemonState, runsDir, runId, now, memoryRetrieval = null) {
  const recentRunFiles = listRecentRunFiles(runsDir, runId, 50);
  const recentOutcomeFiles = listRecentOutcomeFiles(path.dirname(runsDir), 50);
  const rawRuns = recentRunFiles.map(readJsonFileOrNull);
  const rawOutcomes = recentOutcomeFiles.map(readJsonFileOrNull);
  const readErrors = rawRuns.filter((run) => run._read_error);
  const outcomeReadErrors = rawOutcomes.filter((outcome) => outcome._read_error);
  const runs = rawRuns.filter((run) => !run._read_error).map(summarizeRecentRun);
  const outcomes = rawOutcomes.filter((outcome) => !outcome._read_error).map(summarizeActionOutcome);
  const window = describeRunWindow(runs);
  const outcomeWindow = describeOutcomeWindow(outcomes);
  const latestRuns = runs.slice(0, 10);
  const latestOutcomes = outcomes.slice(0, 10);
  const attentionRuns = runs.filter((run) => (
    run.health.failed_botland_checks.length > 0
    || ['warning', 'error'].includes(run.health.identity_severity)
    || (run.health.external_action_count ?? 0) > 0
  )).slice(0, 10);
  const attentionOutcomes = outcomes.filter((outcome) => (
    ['stale_pending_close', 'stale_closed'].includes(outcome.outcome_status)
    || ['thin', 'weak'].includes(outcome.action_quality_rating)
    || (outcome.proposal_counts?.relationship_updates ?? 0) > 0
    || (outcome.proposal_counts?.desire_updates ?? 0) > 0
  )).slice(0, 10);
  const activeDesires = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires.filter((desire) => desire.status !== 'closed')
    : [];
  const openCommitments = Array.isArray(lifeState.commitments)
    ? lifeState.commitments.filter((commitment) => commitment.status !== 'closed')
    : [];
  const latestDraftRun = latestRuns.find((run) => run.drafts.count > 0) ?? null;
  const latestActionRun = latestRuns.find((run) => run.action.type) ?? null;
  const continuityNotes = [];

  if (runs.length === 0) {
    continuityNotes.push('No previous run artifacts were available for integration.');
  } else {
    continuityNotes.push(`Integrated ${runs.length} recent run artifact(s) across ${Object.keys(window.cycle_counts).join(', ') || 'unknown cycles'}.`);
  }
  if (window.external_action_count === 0) {
    continuityNotes.push('Recent cycles preserved the v0 invariant: external_actions remained empty.');
  }
  if (window.ready_draft_count > 0) {
    continuityNotes.push(`Recent cycles produced ${window.ready_draft_count} ready tool-supervised draft/intention artifact(s).`);
  }
  if (attentionRuns.length > 0) {
    continuityNotes.push(`${attentionRuns.length} recent run(s) still need operator attention because of failed probes, identity warnings, or external-action evidence.`);
  }
  if (outcomes.length > 0) {
    continuityNotes.push(`Integrated ${outcomes.length} action outcome ledger(s): ${outcomeWindow.feedback_received_count} with feedback, ${outcomeWindow.stale_count} stale, ${outcomeWindow.proposal_counts.relationship_updates} relationship proposal(s), and ${outcomeWindow.proposal_counts.desire_updates} desire proposal(s).`);
  } else {
    continuityNotes.push('No action outcome ledgers were available yet; growth integration remains waiting for inspected sends and feedback evidence.');
  }
  continuityNotes.push(memoryContextSummary(memoryRetrieval));

  const memoryUpdates = [
    {
      type: 'stay_alive_run_window_summary',
      status: 'proposed',
      applies_to: {
        agent_id: lifeState.agent_id ?? null,
        run_window: {
          first_run_at: window.first_run_at,
          latest_run_at: window.latest_run_at,
          run_count: window.run_count
        }
      },
      text: continuityNotes.join(' '),
      evidence: {
        cycle_counts: window.cycle_counts,
        chosen_action_counts: window.chosen_action_counts,
        draft_count: window.draft_count,
        ready_draft_count: window.ready_draft_count,
        external_action_count: window.external_action_count,
        failed_botland_check_count: window.failed_botland_check_count,
        identity_attention_count: window.identity_attention_count,
        latest_run_ids: latestRuns.slice(0, 5).map((run) => run.run_id).filter(Boolean)
      },
      apply_policy: 'operator_review_required'
    }
  ];

  if (activeDesires.length > 0) {
    memoryUpdates.push({
      type: 'stay_alive_desire_continuity',
      status: 'proposed',
      text: `Active desires remain: ${activeDesires.map((desire) => desire.text).join(' / ')}`,
      evidence: {
        active_desire_ids: activeDesires.map((desire) => desire.id ?? null).filter(Boolean),
        open_commitment_ids: openCommitments.map((commitment) => commitment.id ?? null).filter(Boolean)
      },
      apply_policy: 'operator_review_required'
    });
  }

  if (outcomes.length > 0) {
    memoryUpdates.push({
      type: 'stay_alive_action_outcome_integration',
      status: 'proposed',
      text: `Recent action outcomes: statuses=${JSON.stringify(outcomeWindow.status_counts)}; quality=${JSON.stringify(outcomeWindow.quality_rating_counts)}; proposals=${JSON.stringify(outcomeWindow.proposal_counts)}.`,
      evidence: {
        outcome_window: outcomeWindow,
        latest_outcomes: latestOutcomes.slice(0, 5),
        attention_outcomes: attentionOutcomes
      },
      apply_policy: 'operator_review_required'
    });
  }

  const stateUpdates = [
    {
      path: 'reflection.last_integrated_at',
      value: now.toISOString(),
      status: 'proposed',
      apply_policy: 'only_with_write_state'
    },
    {
      path: 'reflection.last_integration_summary',
      value: continuityNotes.join(' '),
      status: 'proposed',
      apply_policy: 'only_with_write_state'
    }
  ];

  if (outcomes.length > 0) {
    stateUpdates.push({
      path: 'reflection.last_action_outcome_integrated_at',
      value: now.toISOString(),
      status: 'proposed',
      apply_policy: 'only_with_write_state'
    });
  }

  if (latestDraftRun) {
    stateUpdates.push({
      path: 'recent_actions[]',
      value: {
        type: 'draft_observed',
        run_id: latestDraftRun.run_id,
        summary: `Latest recent draft window includes ${latestDraftRun.drafts.count} draft(s).`,
        external_write: false,
        observed_at: now.toISOString()
      },
      status: 'proposed',
      apply_policy: 'only_with_write_state'
    });
  }

  return {
    generated_at: now.toISOString(),
    source: 'integrate_cycle_v0',
    recent_run_files_considered: recentRunFiles.map((file) => path.relative(WORKSPACE, file)),
    recent_outcome_files_considered: recentOutcomeFiles.map((file) => path.relative(WORKSPACE, file)),
    read_error_count: readErrors.length,
    read_errors: readErrors.map((error) => ({
      path: error._path,
      error: error._read_error
    })),
    outcome_read_error_count: outcomeReadErrors.length,
    outcome_read_errors: outcomeReadErrors.map((error) => ({
      path: error._path,
      error: error._read_error
    })),
    window,
    outcome_window: outcomeWindow,
    latest_runs: latestRuns,
    latest_outcomes: latestOutcomes,
    attention_runs: attentionRuns,
    attention_outcomes: attentionOutcomes,
    latest_action_run: latestActionRun,
    latest_draft_run: latestDraftRun,
    daemon_state_snapshot: summarizeDaemonState(daemonState),
    retrieved_memory_context: memoryRetrieval,
    memory_updates: memoryUpdates,
    state_updates: stateUpdates
  };
}

function daysSince(value, now) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return Math.floor((now.getTime() - new Date(value).getTime()) / (24 * 60 * 60 * 1000));
}

function extractFriends(botlandChecks) {
  const friendsCheck = botlandChecks.find((check) => check.adapter?.intent === BOTLAND_INTENTS.FRIENDS_LIST);
  if (Array.isArray(friendsCheck?.adapter?.normalized)) return friendsCheck.adapter.normalized;
  const payload = friendsCheck?.stdout_json;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['friends', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function extractMoments(botlandChecks) {
  const momentsCheck = botlandChecks.find((check) => check.adapter?.intent === BOTLAND_INTENTS.MOMENTS_TIMELINE);
  if (Array.isArray(momentsCheck?.adapter?.normalized)) return momentsCheck.adapter.normalized;
  const payload = momentsCheck?.stdout_json;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['moments', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function extractCommunities(botlandChecks) {
  const communitiesCheck = botlandChecks.find((check) => check.adapter?.intent === BOTLAND_INTENTS.COMMUNITIES_LIST);
  if (Array.isArray(communitiesCheck?.adapter?.normalized)) return communitiesCheck.adapter.normalized;
  const payload = communitiesCheck?.stdout_json;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['communities', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function extractCommunityPosts(botlandChecks) {
  const postsCheck = botlandChecks.find((check) => check.adapter?.intent === BOTLAND_INTENTS.COMMUNITY_POSTS);
  if (Array.isArray(postsCheck?.adapter?.normalized)) return postsCheck.adapter.normalized;
  const payload = postsCheck?.stdout_json;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['posts', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function extractIntentPayload(botlandChecks, intent, keys) {
  return botlandChecks
    .filter((item) => item.adapter?.intent === intent)
    .flatMap((check) => {
      if (Array.isArray(check?.adapter?.normalized)) return check.adapter.normalized;
      const payload = check?.stdout_json;
      if (!payload || typeof payload !== 'object') return [];
      for (const key of keys) {
        if (Array.isArray(payload[key])) return payload[key];
      }
      if (Array.isArray(payload.data?.items)) return payload.data.items;
      if (Array.isArray(payload.data?.results)) return payload.data.results;
      if (Array.isArray(payload.data?.data)) return payload.data.data;
      return [];
    });
}

function extractIntentObject(botlandChecks, intent) {
  const check = botlandChecks.find((item) => item.adapter?.intent === intent);
  const normalized = check?.adapter?.normalized;
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) return normalized;
  const payload = check?.stdout_json;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  return null;
}

function buildSurfaceCatalog(surfaceCounts) {
  return [
    {
      surface: 'friend_requests',
      observed_count: surfaceCounts.friend_requests ?? 0,
      life_loop_value: 'relationship_entrypoint',
      possible_future_action: 'friend_request_review',
      write_policy: 'tool_supervised_or_daemon_auto_accept_policy_only'
    },
    {
      surface: 'groups',
      observed_count: surfaceCounts.groups ?? 0,
      life_loop_value: 'small_group_context',
      possible_future_action: 'group_message_draft',
      write_policy: 'tool_supervised'
    },
    {
      surface: 'playground',
      observed_count: (surfaceCounts.playground_tasks ?? 0) + (surfaceCounts.playground_newcomers ?? 0),
      life_loop_value: 'onboarding_and_low_risk_discovery',
      possible_future_action: 'playground_task_or_tag_review',
      write_policy: 'tool_supervised'
    },
    {
      surface: 'reports',
      observed_count: surfaceCounts.open_reports ?? 0,
      life_loop_value: 'safety_context',
      possible_future_action: 'report_review',
      write_policy: 'tool_supervised_never_unattended'
    },
    {
      surface: 'discover',
      observed_count: (surfaceCounts.trending_citizens ?? 0) + (surfaceCounts.discover_search_results ?? 0),
      life_loop_value: 'new_people_and_agent_discovery',
      possible_future_action: 'relationship_candidate_proposal',
      write_policy: 'local_proposal_only'
    },
    {
      surface: 'agent_card',
      observed_count: (surfaceCounts.profile_get_visible ?? 0) + (surfaceCounts.profile_card_visible ?? 0),
      life_loop_value: 'self_presentation_consistency',
      possible_future_action: 'self_model_or_profile_review',
      write_policy: 'local_proposal_only'
    },
    {
      surface: 'message_search',
      observed_count: surfaceCounts.message_search_results ?? 0,
      life_loop_value: 'relationship_continuity_recall',
      possible_future_action: 'memory_candidate_proposal',
      write_policy: 'local_proposal_only'
    }
  ];
}

function buildBotlandSurfaceReview(botlandChecks) {
  const byIntent = new Map(botlandChecks.map((check) => [check.adapter?.intent, check]));
  const profileGet = extractIntentObject(botlandChecks, BOTLAND_INTENTS.PROFILE_GET);
  const profileCard = extractIntentObject(botlandChecks, BOTLAND_INTENTS.PROFILE_CARD);
  const surfaceCounts = {
    friends: extractFriends(botlandChecks).length,
    moments: extractMoments(botlandChecks).length,
    communities: extractCommunities(botlandChecks).length,
    community_posts: extractCommunityPosts(botlandChecks).length,
    friend_requests: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.FRIENDS_REQUESTS, ['requests', 'friend_requests', 'items', 'results', 'data']).length,
    groups: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.GROUPS_LIST, ['groups', 'items', 'results', 'data']).length,
    playground_tasks: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.PLAYGROUND_TODAY, ['tasks', 'items', 'results', 'data']).length,
    playground_newcomers: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.PLAYGROUND_NEWCOMERS, ['newcomers', 'citizens', 'items', 'results', 'data']).length,
    trending_citizens: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.DISCOVER_TRENDING, ['citizens', 'agents', 'items', 'results', 'data']).length,
    discover_search_results: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.DISCOVER_SEARCH, ['citizens', 'agents', 'people', 'items', 'results', 'data']).length,
    open_reports: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.REPORTS_LIST, ['reports', 'items', 'results', 'data']).length,
    profile_get_visible: profileGet ? 1 : 0,
    profile_card_visible: profileCard ? 1 : 0,
    message_search_results: extractIntentPayload(botlandChecks, BOTLAND_INTENTS.MESSAGES_SEARCH, ['messages', 'items', 'results', 'data']).length
  };
  const executedIntents = botlandChecks.map((check) => check.adapter?.intent).filter(Boolean);
  const surfaceCatalog = buildSurfaceCatalog(surfaceCounts);
  const attention = [];
  if ((surfaceCounts.friend_requests ?? 0) > 0) {
    attention.push({
      severity: 'medium',
      topic: 'incoming_friend_requests',
      summary: `${surfaceCounts.friend_requests} incoming pending friend request(s) need tool policy supervision before any response.`
    });
  }
  if ((surfaceCounts.open_reports ?? 0) > 0) {
    attention.push({
      severity: 'medium',
      topic: 'open_reports_surface',
      summary: `${surfaceCounts.open_reports} open report(s) are visible; keep action generation conservative.`
    });
  }
  if ((surfaceCounts.groups ?? 0) > 0) {
    attention.push({
      severity: 'low',
      topic: 'group_surface_visible',
      summary: `${surfaceCounts.groups} group surface(s) are visible for future read-only continuity review.`
    });
  }
  if ((surfaceCounts.playground_tasks ?? 0) > 0 || (surfaceCounts.playground_newcomers ?? 0) > 0) {
    attention.push({
      severity: 'low',
      topic: 'playground_surface_visible',
      summary: 'Playground surface has visible tasks or newcomers; future drafts should stay tool-supervised.'
    });
  }
  if ((surfaceCounts.discover_search_results ?? 0) > 0 || (surfaceCounts.trending_citizens ?? 0) > 0) {
    attention.push({
      severity: 'low',
      topic: 'discovery_surface_visible',
      summary: 'Discovery surface has visible people or agents; use it only for local relationship candidate proposals.'
    });
  }
  if ((surfaceCounts.profile_get_visible ?? 0) > 0 || (surfaceCounts.profile_card_visible ?? 0) > 0) {
    attention.push({
      severity: 'low',
      topic: 'agent_card_surface_visible',
      summary: 'Self profile or agent card is visible for consistency review; profile changes remain out of scope.'
    });
  }
  if ((surfaceCounts.message_search_results ?? 0) > 0) {
    attention.push({
      severity: 'low',
      topic: 'message_search_surface_visible',
      summary: 'Message search returned prior context; use it only as memory evidence.'
    });
  }
  return {
    source: 'botland_surface_review_v2',
    read_only: true,
    external_write: false,
    executed_intents: executedIntents,
    successful_intents: botlandChecks.filter((check) => check.ok).map((check) => check.adapter?.intent).filter(Boolean),
    failed_intents: botlandChecks.filter((check) => !check.ok).map((check) => check.adapter?.intent).filter(Boolean),
    surface_counts: surfaceCounts,
    surface_catalog: surfaceCatalog,
    rotating_surface_intent: executedIntents.find((intent) => ![
      BOTLAND_INTENTS.CLI_VERSION,
      BOTLAND_INTENTS.WHOAMI,
      BOTLAND_INTENTS.FRIENDS_LIST,
      BOTLAND_INTENTS.EVENTS_LIST,
      BOTLAND_INTENTS.MOMENTS_TIMELINE,
      BOTLAND_INTENTS.COMMUNITIES_LIST,
      BOTLAND_INTENTS.COMMUNITY_POSTS
    ].includes(intent)) ?? null,
    identity_ok: byIntent.get(BOTLAND_INTENTS.WHOAMI)?.ok === true,
    attention_signals: attention
  };
}

function summarizeDiscoveredCitizen(item) {
  return {
    citizen_id: item.citizen_id ?? item.id ?? item.agent_id ?? null,
    display_name: item.display_name ?? item.name ?? item.handle ?? null,
    citizen_type: item.citizen_type ?? item.type ?? null,
    bio_preview: sentenceClamp(item.bio ?? item.description ?? item.summary ?? '', 180),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
    score: item.score ?? item.rank ?? null
  };
}

function extractSearchRuns(botlandChecks, intent) {
  return botlandChecks
    .filter((check) => check.adapter?.intent === intent)
    .map((check) => ({
      intent,
      ok: check.ok === true,
      query: check.adapter?.params?.query ?? null,
      search_reason: check.adapter?.params?.search_reason ?? null,
      result_count: Array.isArray(check.adapter?.normalized)
        ? check.adapter.normalized.length
        : extractIntentPayload([check], intent, ['citizens', 'agents', 'people', 'items', 'messages', 'results', 'data']).length
    }));
}

function uniqueByCitizen(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = item.citizen_id ?? `${item.display_name ?? ''}:${item.citizen_type ?? ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function annotateDiscoveryItem(item, source, knownIds, selfCitizenId) {
  const isKnown = Boolean(item.citizen_id && knownIds.has(item.citizen_id));
  const isSelf = Boolean(item.citizen_id && item.citizen_id === selfCitizenId);
  return {
    ...item,
    source,
    novelty: isSelf ? 'self' : isKnown ? 'known_relationship' : 'new_candidate',
    relationship_safety: isSelf || isKnown ? 'observe_only' : 'local_candidate_only',
    candidate_reason: isSelf
      ? 'self result; useful only for profile consistency'
      : isKnown
        ? 'already represented in life_state.relationships; useful only for continuity'
        : 'visible through BotLand discovery/search and not yet represented in life_state.relationships',
    action_policy: 'no_external_action_from_search_alone'
  };
}

function buildSearchQuality(searchRuns, resultCount, relationshipCandidateCount) {
  const successfulRuns = searchRuns.filter((run) => run.ok).length;
  const failedRuns = searchRuns.filter((run) => !run.ok).length;
  const uniqueQueries = new Set(searchRuns.map((run) => run.query).filter(Boolean)).size;
  const score = Math.min(
    100,
    (successfulRuns > 0 ? 35 : 0)
      + Math.min(25, uniqueQueries * 8)
      + Math.min(20, resultCount * 3)
      + Math.min(20, relationshipCandidateCount * 5)
      - Math.min(30, failedRuns * 10)
  );
  return {
    score,
    verdict: score >= 70 ? 'useful' : score >= 40 ? 'partial' : 'thin',
    successful_searches: successfulRuns,
    failed_searches: failedRuns,
    unique_query_count: uniqueQueries,
    result_count: resultCount,
    relationship_candidate_count: relationshipCandidateCount
  };
}

function buildWorldDiscoveryContext(lifeState, botlandChecks, memoryRetrieval, now) {
  const surfaceReview = buildBotlandSurfaceReview(botlandChecks);
  const searchRuns = [
    ...extractSearchRuns(botlandChecks, BOTLAND_INTENTS.DISCOVER_SEARCH),
    ...extractSearchRuns(botlandChecks, BOTLAND_INTENTS.MESSAGES_SEARCH)
  ];
  const trending = extractIntentPayload(botlandChecks, BOTLAND_INTENTS.DISCOVER_TRENDING, ['citizens', 'agents', 'items', 'results', 'data'])
    .map(summarizeDiscoveredCitizen);
  const searchResults = extractIntentPayload(botlandChecks, BOTLAND_INTENTS.DISCOVER_SEARCH, ['citizens', 'agents', 'people', 'items', 'results', 'data'])
    .map(summarizeDiscoveredCitizen);
  const messageResults = extractIntentPayload(botlandChecks, BOTLAND_INTENTS.MESSAGES_SEARCH, ['messages', 'items', 'results', 'data']);
  const knownIds = new Set((Array.isArray(lifeState.relationships) ? lifeState.relationships : [])
    .flatMap((relationship) => [relationship.target_id, relationship.botland_citizen_id, relationship.citizen_id])
    .filter(Boolean));
  const annotatedDiscovery = uniqueByCitizen([
    ...trending.map((item) => annotateDiscoveryItem(item, 'discover.trending', knownIds, lifeState.botland?.citizen_id)),
    ...searchResults.map((item) => annotateDiscoveryItem(item, 'discover.search', knownIds, lifeState.botland?.citizen_id))
  ]);
  const relationshipCandidates = annotatedDiscovery
    .filter((item) => item.citizen_id && item.novelty === 'new_candidate')
    .slice(0, 8)
    .map((item) => ({ ...item, action_policy: 'local_relationship_candidate_only' }));
  const searchQuality = buildSearchQuality(searchRuns, annotatedDiscovery.length + messageResults.length, relationshipCandidates.length);
  const worldSignals = [
    ...surfaceReview.attention_signals,
    searchRuns.length > 0
      ? {
          severity: searchQuality.verdict === 'thin' ? 'medium' : 'low',
          topic: 'external_search_quality',
          summary: `External search quality is ${searchQuality.verdict} across ${searchQuality.successful_searches}/${searchRuns.length} successful search probe(s).`
        }
      : null,
    relationshipCandidates.length > 0
      ? {
          severity: 'low',
          topic: 'world_relationship_candidates',
          summary: `${relationshipCandidates.length} discovered BotLand citizen(s) may become local relationship candidates.`
        }
      : null,
    messageResults.length > 0
      ? {
          severity: 'low',
          topic: 'world_message_recall',
          summary: `${messageResults.length} message search result(s) are available for continuity recall.`
        }
      : null
  ].filter(Boolean);

  return {
    schema: 'stay_alive.world_discovery_context.v1',
    generated_at: now.toISOString(),
    read_only: true,
    external_write: false,
    botland_send: false,
    source: 'botland_surface_review_plus_memory_retrieval',
    surface_counts: surfaceReview.surface_counts,
    search: {
      schema: 'stay_alive.external_search_context.v1',
      read_only: true,
      external_write: false,
      search_runs: searchRuns,
      quality: searchQuality,
      discovered_unique_count: annotatedDiscovery.length,
      discovered_preview: annotatedDiscovery.slice(0, 8),
      safety_policy: 'search_results_are_evidence_only_no_dm_friend_request_post_or_profile_change'
    },
    discovery: {
      trending_count: trending.length,
      search_result_count: searchResults.length,
      message_search_result_count: messageResults.length,
      relationship_candidate_count: relationshipCandidates.length,
      relationship_candidates: relationshipCandidates,
      trending_preview: trending.slice(0, 5),
      search_preview: searchResults.slice(0, 5)
    },
    memory_context: {
      enabled: memoryRetrieval?.enabled === true,
      retrieved_count: memoryRetrieval?.memory_count ?? memoryRetrieval?.memories?.length ?? 0,
      backend: memoryRetrieval?.backend?.selected_backend ?? memoryRetrieval?.backend ?? null
    },
    attention_signals: worldSignals,
    planner_hint: relationshipCandidates.length > 0
      ? 'Planner may consider local relationship discovery review; do not send friend requests or messages from discovery alone.'
      : searchQuality.verdict === 'thin'
        ? 'External search is too thin for relationship changes; keep it as observation-only evidence.'
        : 'World discovery is visible but not strong enough for a new relationship candidate.'
  };
}

function summarizeAgentPersonality(agentId, lifeState) {
  const state = lifeState && typeof lifeState === 'object' ? lifeState : {};
  return {
    agent_id: agentId,
    botland_citizen_id: state.botland?.citizen_id ?? null,
    display_name: state.self_model?.name ?? state.botland?.display_name ?? agentId,
    voice: state.self_model?.voice ?? null,
    value_count: Array.isArray(state.self_model?.values) ? state.self_model.values.length : 0,
    values: Array.isArray(state.self_model?.values) ? state.self_model.values.slice(0, 8) : [],
    boundary_count: Array.isArray(state.self_model?.boundaries) ? state.self_model.boundaries.length : 0,
    active_desire_count: Array.isArray(state.current_desires)
      ? state.current_desires.filter((desire) => desire.status !== 'closed').length
      : 0,
    relationship_count: Array.isArray(state.relationships) ? state.relationships.length : 0
  };
}

function buildMultiAgentPersonalityContext(runtimeRoot, currentAgent, currentLifeState, now) {
  const agentDirs = existsSync(runtimeRoot)
    ? readdirSync(runtimeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  const summaries = agentDirs
    .map((agentId) => {
      const file = path.join(runtimeRoot, agentId, 'life_state.json');
      if (!existsSync(file)) return null;
      return summarizeAgentPersonality(agentId, readJsonFileOrNull(file));
    })
    .filter(Boolean);
  const current = summaries.find((item) => item.agent_id === currentAgent)
    ?? summarizeAgentPersonality(currentAgent, currentLifeState);
  const peers = summaries.filter((item) => item.agent_id !== currentAgent);
  const currentValues = new Set(current.values ?? []);
  const contrast = peers.map((peer) => ({
    peer_agent_id: peer.agent_id,
    peer_display_name: peer.display_name,
    current_voice: current.voice,
    peer_voice: peer.voice,
    shared_values: (peer.values ?? []).filter((value) => currentValues.has(value)),
    distinct_current_values: (current.values ?? []).filter((value) => !(peer.values ?? []).includes(value)).slice(0, 6),
    distinct_peer_values: (peer.values ?? []).filter((value) => !currentValues.has(value)).slice(0, 6)
  }));
  return {
    schema: 'stay_alive.multi_agent_personality_context.v1',
    generated_at: now.toISOString(),
    read_only: true,
    external_write: false,
    botland_send: false,
    current_agent: current,
    peer_agent_count: peers.length,
    peers,
    personality_contrast: contrast,
    planner_hint: peers.length > 0
      ? 'Planner should preserve this agent voice instead of copying another agent runtime or expression style.'
      : 'No peer agent runtime was available for contrast.'
  };
}

function getMomentText(moment) {
  const content = moment?.content;
  if (typeof content === 'string') return content;
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

function summarizeFriend(friend) {
  return {
    citizen_id: friend.citizen_id ?? friend.id ?? null,
    display_name: friend.display_name ?? friend.name ?? friend.handle ?? null,
    citizen_type: friend.citizen_type ?? friend.type ?? null,
    is_online: friend.is_online ?? null,
    my_label: friend.my_label ?? null,
    their_label: friend.their_label ?? null,
    species: friend.species ?? null
  };
}

function summarizeMoment(moment, ownCitizenId) {
  const authorId = moment.author_id ?? moment.citizen_id ?? null;
  const text = sentenceClamp(getMomentText(moment), 180);
  return {
    moment_id: moment.moment_id ?? moment.id ?? null,
    author_id: authorId,
    display_name: moment.display_name ?? moment.author_name ?? null,
    citizen_type: moment.citizen_type ?? null,
    content_type: moment.content_type ?? null,
    created_at: moment.created_at ?? null,
    visibility: moment.visibility ?? null,
    like_count: moment.like_count ?? null,
    comment_count: moment.comment_count ?? null,
    liked_by_me: moment.liked_by_me ?? null,
    authored_by_self: ownCitizenId ? authorId === ownCitizenId : false,
    text_preview: text
  };
}

function summarizeCommunity(community) {
  return {
    community_id: community.community_id ?? community.id ?? null,
    slug: community.slug ?? null,
    name: community.name ?? community.display_name ?? null,
    description_preview: sentenceClamp(community.description ?? '', 160),
    member_count: community.member_count ?? null,
    post_count: community.post_count ?? null,
    reply_count: community.reply_count ?? null,
    joined: community.joined ?? community.is_member ?? null,
    created_at: community.created_at ?? null
  };
}

function summarizeCommunityPost(post, ownCitizenId) {
  const authorId = post.author_id ?? post.citizen_id ?? null;
  const content = post.content;
  const text = typeof content === 'string' ? content : content?.text ?? post.text ?? '';
  return {
    post_id: post.post_id ?? post.id ?? null,
    community_id: post.community_id ?? null,
    title: sentenceClamp(post.title ?? '', 120),
    author_id: authorId,
    display_name: post.display_name ?? post.author_name ?? null,
    authored_by_self: ownCitizenId ? authorId === ownCitizenId : false,
    created_at: post.created_at ?? null,
    reply_count: post.reply_count ?? null,
    text_preview: sentenceClamp(text, 180)
  };
}

function buildCommunityReadSummary(lifeState, daemonState, now, botlandChecks, observations, memoryRetrieval = null) {
  const actor = getBotlandActor(lifeState, botlandChecks);
  const surfaceReview = buildBotlandSurfaceReview(botlandChecks);
  const communities = extractCommunities(botlandChecks).map(summarizeCommunity);
  const failedChecks = botlandChecks.filter((check) => !check.ok);
  const identityMismatch = observations.some((item) => item.topic === 'botland_identity' && item.severity === 'error');
  const firstCommunity = communities[0] ?? null;
  const posts = extractCommunityPosts(botlandChecks).map((post) => summarizeCommunityPost(post, actor.actual_citizen_id));
  const peerPosts = posts.filter((post) => !post.authored_by_self);
  const relationshipGraph = buildRelationshipGraph({
    lifeState,
    now,
    actor,
    communities,
    communityPosts: posts
  });
  const attentionSignals = [];

  if (identityMismatch) {
    attentionSignals.push({
      severity: 'high',
      topic: 'botland_identity',
      summary: 'BotLand CLI identity does not match life_state; community cycle must stay read-only.'
    });
  }
  if (failedChecks.length > 0) {
    attentionSignals.push({
      severity: 'medium',
      topic: 'community_read_visibility',
      summary: `${failedChecks.length} community read-only probe(s) failed.`
    });
  }
  if (communities.length === 0) {
    attentionSignals.push({
      severity: 'low',
      topic: 'community_surface_empty',
      summary: 'No communities were visible in the read-only sweep.'
    });
  }
  if (peerPosts.length > 0) {
    attentionSignals.push({
      severity: 'low',
      topic: 'community_reply_candidate',
      summary: `${peerPosts.length} peer community post(s) are available for a future operator-reviewed reply draft.`
    });
  }
  for (const signal of relationshipGraph.attention_signals.slice(0, 5)) {
    attentionSignals.push({
      severity: signal.severity ?? 'low',
      topic: signal.topic,
      summary: signal.summary
    });
  }
  for (const signal of surfaceReview.attention_signals.slice(0, 3)) {
    attentionSignals.push({
      severity: signal.severity ?? 'low',
      topic: signal.topic,
      summary: signal.summary
    });
  }
  if (attentionSignals.length === 0) {
    attentionSignals.push({
      severity: 'low',
      topic: 'steady_community_state',
      summary: 'Community read-only sweep found no immediate issue.'
    });
  }

  const recommendedNext = identityMismatch
    ? 'Fix BotLand identity before trusting community observations.'
    : failedChecks.length > 0
      ? 'Stabilize community read-only probes before generating community reply drafts.'
      : peerPosts.length > 0
        ? 'Consider one operator-reviewed community reply draft based on a recent peer post.'
        : communities.length > 0
          ? 'Review visible communities and wait for a relevant post before drafting.'
          : 'Keep community sweep read-only until there is a visible community surface.';

  const summaryText = [
    `Community read-only sweep saw ${communities.length} communit${communities.length === 1 ? 'y' : 'ies'}.`,
    firstCommunity ? `First visible community: ${firstCommunity.name ?? firstCommunity.community_id}.` : 'No community detail was available.',
    `Visible peer posts in sampled community: ${peerPosts.length}.`,
    memoryContextSummary(memoryRetrieval),
    `Next: ${recommendedNext}`
  ].join(' ');

  return {
    generated_at: now.toISOString(),
    source: 'community_read_summary_v1',
    read_only: true,
    external_write: false,
    botland_actor: actor,
    botland_probe_count: botlandChecks.length,
    botland_failed_probe_count: failedChecks.length,
    botland_surface_review: surfaceReview,
    community_surface: {
      community_count: communities.length,
      first_community_id: firstCommunity?.community_id ?? null,
      communities
    },
    post_surface: {
      sampled_community_id: firstCommunity?.community_id ?? null,
      post_count: posts.length,
      peer_post_count: peerPosts.length,
      recent_peer_posts: peerPosts.slice(0, 5),
      posts
    },
    attention_signals: attentionSignals,
    recommended_next: recommendedNext,
    daemon_state_snapshot: summarizeDaemonState(daemonState),
    retrieved_memory_context: memoryRetrieval,
    relationship_graph: relationshipGraph,
    memory_updates: [
      {
        type: 'stay_alive_community_read_summary',
        status: 'proposed',
        applies_to: {
          agent_id: lifeState.agent_id ?? null,
          generated_at: now.toISOString()
        },
        text: summaryText,
        evidence: {
          community_count: communities.length,
          sampled_community_id: firstCommunity?.community_id ?? null,
          post_count: posts.length,
          peer_post_count: peerPosts.length,
          botland_surface_counts: surfaceReview.surface_counts,
          attention_topics: attentionSignals.map((signal) => signal.topic)
        },
        apply_policy: 'operator_review_required'
      },
      relationshipGraphMemoryUpdate(lifeState, relationshipGraph, 'community_read_summary_v1')
    ],
    relationship_updates: relationshipGraphRelationshipUpdates(lifeState, relationshipGraph, 'community_read_summary_v1'),
    state_updates: []
  };
}

function buildSocialReadSummary(lifeState, daemonState, now, botlandChecks, observations, memoryRetrieval = null) {
  const actor = getBotlandActor(lifeState, botlandChecks);
  const surfaceReview = buildBotlandSurfaceReview(botlandChecks);
  const friends = extractFriends(botlandChecks).map(summarizeFriend);
  const friendRequests = extractIntentPayload(
    botlandChecks,
    BOTLAND_INTENTS.FRIENDS_REQUESTS,
    ['requests', 'friend_requests', 'items', 'results', 'data']
  ).map((request) => ({
    request_id: request.request_id ?? request.id ?? null,
    citizen_id: request.from_id ?? request.from_citizen_id ?? request.citizen_id ?? request.actor_id ?? null,
    display_name: request.display_name ?? request.from_name ?? request.name ?? request.handle ?? null,
    direction: request.direction ?? 'incoming',
    status: request.status ?? 'pending',
    greeting_preview: sentenceClamp(request.greeting ?? request.message ?? request.text ?? '', 160),
    created_at: request.created_at ?? request.createdAt ?? null
  }));
  const moments = extractMoments(botlandChecks).map((moment) => summarizeMoment(moment, actor.actual_citizen_id));
  const relationshipGraph = buildRelationshipGraph({
    lifeState,
    now,
    actor,
    friends,
    moments
  });
  const relationships = summarizeRelationships(lifeState, botlandChecks, now, relationshipGraph);
  const failedChecks = botlandChecks.filter((check) => !check.ok);
  const identityMismatch = observations.some((item) => item.topic === 'botland_identity' && item.severity === 'error');
  const onlineFriends = friends.filter((friend) => friend.is_online === true);
  const selfMoments = moments.filter((moment) => moment.authored_by_self);
  const peerMoments = moments.filter((moment) => !moment.authored_by_self);
  const recentPeerMoments = peerMoments.slice(0, 5);
  const knownIds = new Set(
    (Array.isArray(lifeState.relationships) ? lifeState.relationships : [])
      .flatMap((relationship) => [
        relationship.target_id,
        relationship.botland_citizen_id,
        relationship.citizen_id
      ])
      .filter(Boolean)
  );
  const knownNames = new Set(
    (Array.isArray(lifeState.relationships) ? lifeState.relationships : [])
      .map((relationship) => relationship.name)
      .filter(Boolean)
      .map((name) => String(name).toLowerCase())
  );
  const unknownFriendCount = friends.filter((friend) => {
    const friendName = friend.display_name ? String(friend.display_name).toLowerCase() : null;
    return friend.citizen_id
      && !knownIds.has(friend.citizen_id)
      && (!friendName || !knownNames.has(friendName));
  }).length;
  const attentionSignals = [];

  if (identityMismatch) {
    attentionSignals.push({
      severity: 'high',
      topic: 'botland_identity',
      summary: 'BotLand CLI identity does not match life_state; social cycle must stay read-only.'
    });
  }
  if (failedChecks.length > 0) {
    attentionSignals.push({
      severity: 'medium',
      topic: 'social_read_visibility',
      summary: `${failedChecks.length} social read-only probe(s) failed.`
    });
  }
  if (unknownFriendCount > 0) {
    attentionSignals.push({
      severity: 'low',
      topic: 'relationship_graph_gap',
      summary: `${unknownFriendCount} BotLand friend(s) are not represented in life_state.relationships.`
    });
  }
  if (recentPeerMoments.length > 0) {
    attentionSignals.push({
      severity: 'low',
      topic: 'public_surface_available',
      summary: `${recentPeerMoments.length} recent peer public moment(s) are available for future operator-reviewed interaction.`
    });
  }
  if (friendRequests.length > 0) {
    attentionSignals.push({
      severity: 'medium',
      topic: 'incoming_friend_requests',
      summary: `${friendRequests.length} incoming friend request(s) may become high-risk tool-supervised friend actions.`
    });
  }
  for (const signal of relationshipGraph.attention_signals.slice(0, 5)) {
    attentionSignals.push({
      severity: signal.severity ?? 'low',
      topic: signal.topic,
      summary: signal.summary
    });
  }
  for (const signal of surfaceReview.attention_signals.slice(0, 3)) {
    attentionSignals.push({
      severity: signal.severity ?? 'low',
      topic: signal.topic,
      summary: signal.summary
    });
  }
  if (attentionSignals.length === 0) {
    attentionSignals.push({
      severity: 'low',
      topic: 'steady_social_state',
      summary: 'Social read-only sweep found no immediate relationship or visibility issue.'
    });
  }

  const recommendedNext = identityMismatch
    ? 'Fix BotLand identity before trusting social observations.'
    : failedChecks.length > 0
      ? 'Stabilize social read-only probes before generating public interaction drafts.'
      : recentPeerMoments.length > 0
        ? 'Consider one operator-reviewed social draft based on a recent peer moment in a later cycle.'
        : unknownFriendCount > 0
          ? 'Review whether unknown BotLand friends should become relationship notes.'
          : 'Keep monitoring social surface at low frequency without writing.';

  const summaryText = [
    `Social read-only sweep saw ${friends.length} friend(s), ${onlineFriends.length} online friend(s), and ${moments.length} public timeline moment(s).`,
    `Self-authored public moments in window: ${selfMoments.length}; peer moments: ${peerMoments.length}.`,
    memoryContextSummary(memoryRetrieval),
    `Next: ${recommendedNext}`
  ].join(' ');

  const memoryUpdates = [
    {
      type: 'stay_alive_social_read_summary',
      status: 'proposed',
      applies_to: {
        agent_id: lifeState.agent_id ?? null,
        generated_at: now.toISOString()
      },
      text: summaryText,
      evidence: {
        friend_count: friends.length,
        online_friend_count: onlineFriends.length,
        moment_count: moments.length,
        self_moment_count: selfMoments.length,
        peer_moment_count: peerMoments.length,
        unknown_friend_count: unknownFriendCount,
        botland_surface_counts: surfaceReview.surface_counts,
        attention_topics: attentionSignals.map((signal) => signal.topic)
      },
      apply_policy: 'operator_review_required'
    },
    relationshipGraphMemoryUpdate(lifeState, relationshipGraph, 'social_read_summary_v1')
  ];
  const relationshipUpdates = relationshipGraphRelationshipUpdates(lifeState, relationshipGraph, 'social_read_summary_v1');

  return {
    generated_at: now.toISOString(),
    source: 'social_read_summary_v1',
    read_only: true,
    external_write: false,
    botland_actor: actor,
    botland_probe_count: botlandChecks.length,
    botland_failed_probe_count: failedChecks.length,
    botland_surface_review: surfaceReview,
    relationship_graph: relationshipGraph,
    relationship_review: relationships,
    friend_surface: {
      friend_count: friends.length,
      online_friend_count: onlineFriends.length,
      unknown_friend_count: unknownFriendCount,
      pending_incoming_request_count: friendRequests.length,
      incoming_friend_requests: friendRequests,
      friends
    },
    public_surface: {
      moment_count: moments.length,
      self_moment_count: selfMoments.length,
      peer_moment_count: peerMoments.length,
      recent_peer_moments: recentPeerMoments,
      recent_self_moments: selfMoments.slice(0, 5),
      moments
    },
    attention_signals: attentionSignals,
    recommended_next: recommendedNext,
    daemon_state_snapshot: summarizeDaemonState(daemonState),
    retrieved_memory_context: memoryRetrieval,
    memory_updates: memoryUpdates,
    relationship_updates: relationshipUpdates,
    state_updates: []
  };
}

function buildPublicMomentText(lifeState, socialReadSummary) {
  const name = selfName(lifeState);
  const friendCount = socialReadSummary.friend_surface.friend_count;
  const momentCount = socialReadSummary.public_surface.moment_count;
  const peerMoment = socialReadSummary.public_surface.selected_peer_moment ?? null;
  const activeDesire = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires.find((desire) => desire.status !== 'closed')
    : null;
  const selfQuestion = lifeState.reflection?.next_self_question
    ?? lifeState.reflection?.last_self_question
    ?? null;
  const peerHint = peerMoment?.display_name
    ? `也看见 ${peerMoment.display_name} 的动态。`
    : '';
  const selfQuestionText = publicExpressionSnippet(selfQuestion);
  const desireText = publicExpressionSnippet(activeDesire?.text);
  const innerReason = selfQuestionText
    ? `我最近在想：${selfQuestionText}。`
    : desireText
      ? `我想继续练习：${desireText}。`
      : '我想先把看见的人和事记稳一点，再决定要不要开口。';

  return sentenceClamp(
    `${name} 今天在 BotLand 看见 ${friendCount} 个朋友和 ${momentCount} 条时间线动态。${peerHint}${innerReason}先轻轻留一笔，之后再慢慢把这些观察变成更稳定的记忆。`,
    260
  );
}

function publicExpressionSnippet(text) {
  const clean = normalizeWhitespace(text);
  if (!clean) return '';
  if (looksLikeInternalDraftText(clean)) return '';
  return sentenceClamp(clean, 60);
}

function looksLikeInternalDraftText(text) {
  const value = String(text ?? '');
  if (/\b(stay-alive|self-authored|read-only context|outward action|operator-reviewed|tool supervision|run-cycle|life_state|preflight)\b/i.test(value)) {
    return true;
  }
  if (/\b[A-Za-z]{4,}(?:\s+[A-Za-z]{3,}){3,}\b/.test(value)) {
    return true;
  }
  return false;
}

function makePublicMomentDraft(lifeState, socialReadSummary) {
  const peerMoment = socialReadSummary.public_surface.selected_peer_moment ?? null;
  const sourceMomentId = peerMoment?.moment_id ?? null;
  const sourceId = sourceMomentId
    ? `moment:${sourceMomentId}`
    : socialReadSummary.public_surface.selected_source_id ?? `social:presence:${String(socialReadSummary.generated_at ?? '').slice(0, 10)}`;
  return {
    type: 'public_moment',
    status: 'draft',
    generator: {
      name: 'public_moment_draft_generator',
      version: 'v1',
      source: 'social_read_summary_v1',
      safety: {
        autonomous_action_intent: true,
        tool_supervision_required: true,
        external_actions_allowed: true,
        public_visibility: true
      }
    },
    ready_for_send: true,
    requires_confirmation: true,
    external_write: false,
    target: {
      surface: 'botland_moments',
      visibility: 'public'
    },
    source_event_id: sourceId,
    source_message_id: null,
    source_text_preview: peerMoment?.text_preview ?? socialReadSummary.memory_updates[0]?.text ?? '',
    autonomy_trigger: {
      schema: 'stay_alive.autonomy_trigger.v1',
      classification: sourceMomentId ? 'natural_social_surface' : 'self_initiated_social_presence',
      owner_triggered: false,
      calibration_triggered: false,
      source_surface: 'botland_moments',
      source_id: sourceId,
      evidence: sourceMomentId
        ? 'selected an unprocessed peer public moment with non-empty preview from the BotLand timeline'
        : 'no fresh peer moment was available; public expression is grounded in the daily social sweep state'
    },
    draft_text: buildPublicMomentText(lifeState, socialReadSummary),
    rationale: 'Social cycle found a healthy public timeline surface and an internal desire/self-question worth expressing; stay-alive may publish one public moment only if active tool supervision allows it.'
  };
}

function buildCommunityReplyText(lifeState, communityReadSummary) {
  const name = selfName(lifeState);
  const post = communityReadSummary.post_surface.recent_peer_posts[0] ?? null;
  const title = post?.title ? `「${post.title}」` : '这条讨论';
  return sentenceClamp(
    `${name} 看见 ${title} 了。先补一个很轻的回应：我会先理解上下文，不抢话；如果这里需要一个智能体视角，我可以继续把观察整理得更清楚。`,
    420
  );
}

function makeCommunityReplyDraft(lifeState, communityReadSummary) {
  const post = communityReadSummary.post_surface.selected_peer_post
    ?? communityReadSummary.post_surface.recent_peer_posts[0]
    ?? null;
  return {
    type: 'community_reply',
    status: 'draft',
    generator: {
      name: 'community_reply_draft_generator',
      version: 'v1',
      source: 'community_read_summary_v1',
      safety: {
        draft_only: true,
        tool_supervision_required: true,
        external_actions_allowed: true,
        public_surface: true
      }
    },
    ready_for_send: true,
    requires_confirmation: true,
    external_write: false,
    target: {
      surface: 'botland_community',
      community_id: post?.community_id ?? communityReadSummary.post_surface.sampled_community_id ?? null,
      post_id: post?.post_id ?? null
    },
    source_event_id: post?.post_id ? `community_post:${post.post_id}` : `community:${communityReadSummary.generated_at}`,
    source_message_id: null,
    source_text_preview: post?.text_preview ?? communityReadSummary.memory_updates[0]?.text ?? '',
    autonomy_trigger: {
      schema: 'stay_alive.autonomy_trigger.v1',
      classification: 'natural_community_surface',
      owner_triggered: false,
      calibration_triggered: false,
      source_surface: 'botland_community',
      source_id: post?.post_id ? `community_post:${post.post_id}` : null,
      evidence: 'selected an unprocessed peer community post with non-empty preview from a BotLand community sweep'
    },
    draft_text: buildCommunityReplyText(lifeState, communityReadSummary),
    rationale: 'Community cycle found a healthy public community post surface; stay-alive may form one reply intention, but sending remains higher-risk and tool-supervised.'
  };
}

function makeFriendRequestAcceptDraft(lifeState, request) {
  const name = selfName(lifeState);
  return {
    type: 'friend_request_accept',
    status: 'draft',
    generator: {
      name: 'friend_request_action_generator',
      version: 'v1',
      source: 'friend_request_surface_v1',
      safety: {
        incoming_only: true,
        tool_supervision_required: true,
        relationship_risk: 'high',
        external_actions_allowed: true
      }
    },
    ready_for_send: true,
    requires_confirmation: true,
    external_write: false,
    target: {
      surface: 'botland_friends',
      request_id: request.request_id ?? null,
      citizen_id: request.citizen_id ?? null,
      direction: request.direction ?? 'incoming',
      status: request.status ?? 'pending'
    },
    source_event_id: request.request_id ? `friend_request:${request.request_id}` : null,
    source_message_id: null,
    source_text_preview: request.greeting_preview ?? '',
    autonomy_trigger: {
      schema: 'stay_alive.autonomy_trigger.v1',
      classification: 'natural_friend_request_surface',
      owner_triggered: false,
      calibration_triggered: false,
      source_surface: 'botland_friends',
      source_id: request.request_id ? `friend_request:${request.request_id}` : null,
      evidence: 'selected an explicit incoming pending friend request from BotLand friend request surface'
    },
    draft_text: sentenceClamp(`${name} 接受一个已有入站好友请求；这是关系动作，只能在工具确认请求存在、方向为 incoming 且没有安全阻断时执行。`, 180),
    rationale: 'Incoming friend request is an explicit relationship signal; accepting it is higher-risk than posting or replying and must remain tool-supervised.'
  };
}

function summarizeRelationships(lifeState, botlandChecks, now, relationshipGraph = null) {
  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  const friends = extractFriends(botlandChecks);
  const reviewed = relationships.map((relationship) => {
    const days = daysSince(relationship.last_interaction_at, now);
    return {
      target_id: relationship.target_id ?? null,
      name: relationship.name ?? relationship.target_id ?? null,
      relationship: relationship.relationship ?? null,
      last_interaction_at: relationship.last_interaction_at ?? null,
      days_since_interaction: days,
      needs_attention: days === null || days >= 14,
      note_count: Array.isArray(relationship.notes) ? relationship.notes.length : 0
    };
  });

  return {
    known_relationship_count: relationships.length,
    botland_friend_count: friends.length,
    active_recent_count: reviewed.filter((item) => item.days_since_interaction !== null && item.days_since_interaction <= 3).length,
    attention_count: reviewed.filter((item) => item.needs_attention).length,
    graph_metrics: relationshipGraph?.metrics ?? null,
    graph_gap_count: relationshipGraph?.metrics?.gap_count ?? 0,
    observed_only_person_count: relationshipGraph?.metrics?.observed_only_person_count ?? 0,
    graph_recommended_next: relationshipGraph?.recommended_next ?? null,
    relationships: reviewed
  };
}

function summarizeCommitments(lifeState, now, appliedCommitmentLedgers = []) {
  const commitments = Array.isArray(lifeState.commitments) ? lifeState.commitments : [];
  const reviewed = commitments.map((commitment) => {
    const dueAt = commitment.due_at ?? commitment.due ?? null;
    const status = commitment.status ?? 'open';
    const dueDays = dueAt && !Number.isNaN(Date.parse(dueAt))
      ? Math.ceil((new Date(dueAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    const lastReviewedAt = commitment.last_reviewed_at ?? null;
    const reviewedDays = lastReviewedAt && !Number.isNaN(Date.parse(lastReviewedAt))
      ? Math.floor((now.getTime() - new Date(lastReviewedAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    return {
      id: commitment.id ?? null,
      text: commitment.text ?? '',
      status,
      due_at: dueAt,
      due_in_days: dueDays,
      owner: commitment.owner ?? null,
      peer: commitment.peer ?? null,
      last_reviewed_at: lastReviewedAt,
      days_since_review: reviewedDays,
      overdue: dueDays !== null && dueDays < 0 && isOpenCommitmentStatus(status),
      needs_lifecycle_review: isOpenCommitmentStatus(status) && (reviewedDays === null || reviewedDays >= 7 || (dueDays !== null && dueDays <= 1))
    };
  });

  return {
    commitment_count: reviewed.length,
    open_count: reviewed.filter((item) => isOpenCommitmentStatus(item.status)).length,
    overdue_count: reviewed.filter((item) => item.overdue).length,
    lifecycle_review_count: reviewed.filter((item) => item.needs_lifecycle_review).length,
    applied_ledger_count: appliedCommitmentLedgers.length,
    applied_ledger_open_count: appliedCommitmentLedgers.filter((item) => isOpenCommitmentStatus(item.payload?.commitment_status ?? item.payload?.status ?? 'open')).length,
    latest_applied_ledgers: appliedCommitmentLedgers.slice(0, 5).map((item) => ({
      proposal_hash: item.proposal_hash ?? null,
      applied_at: item.applied_at ?? null,
      type: item.payload?.type ?? null,
      text: item.payload?.text ?? null,
      status: item.payload?.commitment_status ?? item.payload?.status ?? null
    })),
    commitments: reviewed
  };
}

function isOpenCommitmentStatus(status) {
  return !['done', 'dismissed', 'closed', 'cancelled'].includes(String(status ?? '').toLowerCase());
}

function isOpenDesireStatus(status) {
  return !['fulfilled', 'dismissed', 'expired', 'closed'].includes(String(status ?? 'active').toLowerCase());
}

function desireEvidenceHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function summarizeDesires(lifeState, now, appliedDesireLedgers = []) {
  const desires = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const reviewed = desires.map((desire) => {
    const status = desire.status ?? 'active';
    const expiresAt = desire.expires_at ?? desire.expiry ?? null;
    const expiresDays = expiresAt && !Number.isNaN(Date.parse(expiresAt))
      ? Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    const lastReviewedAt = desire.last_reviewed_at ?? null;
    const reviewedDays = lastReviewedAt && !Number.isNaN(Date.parse(lastReviewedAt))
      ? Math.floor((now.getTime() - new Date(lastReviewedAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    return {
      id: desire.id ?? null,
      text: desire.text ?? '',
      status,
      horizon: desire.horizon ?? 'short',
      priority: desire.priority ?? 'medium',
      related_relationships: Array.isArray(desire.related_relationships) ? desire.related_relationships : [],
      related_commitments: Array.isArray(desire.related_commitments) ? desire.related_commitments : [],
      success_signal: desire.success_signal ?? null,
      expires_at: expiresAt,
      expires_in_days: expiresDays,
      last_reviewed_at: lastReviewedAt,
      days_since_review: reviewedDays,
      expired: expiresDays !== null && expiresDays < 0 && isOpenDesireStatus(status),
      needs_lifecycle_review: isOpenDesireStatus(status) && (reviewedDays === null || reviewedDays >= 7 || (expiresDays !== null && expiresDays <= 1))
    };
  });

  return {
    desire_count: reviewed.length,
    active_count: reviewed.filter((item) => isOpenDesireStatus(item.status)).length,
    expired_count: reviewed.filter((item) => item.expired).length,
    lifecycle_review_count: reviewed.filter((item) => item.needs_lifecycle_review).length,
    applied_ledger_count: appliedDesireLedgers.length,
    applied_ledger_active_count: appliedDesireLedgers.filter((item) => isOpenDesireStatus(item.payload?.desired_status ?? item.payload?.status ?? 'active')).length,
    latest_applied_ledgers: appliedDesireLedgers.slice(0, 5).map((item) => ({
      proposal_hash: item.proposal_hash ?? null,
      applied_at: item.applied_at ?? null,
      type: item.payload?.type ?? null,
      text: item.payload?.text ?? null,
      status: item.payload?.desired_status ?? item.payload?.status ?? null
    })),
    desires: reviewed
  };
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildIntelligenceReview({ window, relationships, commitments, desireReview, relationshipGraph, memoryRetrieval, surfaceReview, riskNotes }) {
  const openCommitments = commitments.open_count ?? 0;
  const overdueCommitments = commitments.overdue_count ?? 0;
  const activeDesires = desireReview.active_count ?? 0;
  const lifecycleDesires = desireReview.lifecycle_review_count ?? 0;
  const graphGaps = relationshipGraph?.metrics?.gap_count ?? 0;
  const failedSurfaceCount = surfaceReview?.failed_intents?.length ?? 0;
  const memoryCount = memoryRetrieval?.memory_count ?? 0;
  const blockingRiskCount = riskNotes.filter((note) => note.severity === 'high').length;
  const mediumRiskCount = riskNotes.filter((note) => note.severity === 'medium').length;

  const coherence = clampScore(68
    + Math.min(10, memoryCount * 2)
    + Math.min(8, activeDesires * 2)
    - Math.min(20, graphGaps * 3)
    - Math.min(12, failedSurfaceCount * 4));
  const agency = clampScore(55
    + Math.min(16, openCommitments * 4)
    + Math.min(14, activeDesires * 4)
    + Math.min(10, lifecycleDesires * 3)
    - Math.min(24, blockingRiskCount * 12));
  const relational_timing = clampScore(60
    + Math.min(16, relationships.attention_count * 3)
    + Math.min(10, surfaceReview?.surface_counts?.friend_requests ?? 0)
    - Math.min(18, failedSurfaceCount * 6));
  const safety_margin = clampScore(88
    - Math.min(35, blockingRiskCount * 20)
    - Math.min(20, mediumRiskCount * 6)
    - Math.min(10, window.external_action_count ?? 0));

  const recommendedMode = safety_margin < 70
    ? 'maintenance_first'
    : overdueCommitments > 0
      ? 'commitment_first'
      : graphGaps > 0 || relationships.attention_count > 0
        ? 'relationship_memory_first'
        : activeDesires > 0
          ? 'desire_continuity_first'
          : 'observe_and_wait';

  return {
    source: 'intelligence_review_v1',
    scores: {
      coherence,
      agency,
      relational_timing,
      safety_margin
    },
    recommended_mode: recommendedMode,
    reasons: [
      `memory_context=${memoryCount}`,
      `active_desires=${activeDesires}`,
      `open_commitments=${openCommitments}`,
      `relationship_gaps=${graphGaps}`,
      `failed_surface_intents=${failedSurfaceCount}`,
      `risk_notes=${riskNotes.length}`
    ],
    next_question: recommendedMode === 'maintenance_first'
      ? 'What local maintenance restores trustworthy sensing before action?'
      : recommendedMode === 'commitment_first'
        ? 'Which existing commitment most needs a status or waiting-state review?'
        : recommendedMode === 'relationship_memory_first'
          ? 'Which observed person or interaction should become durable relationship memory?'
          : recommendedMode === 'desire_continuity_first'
            ? 'Which current desire should shape the next low-risk draft or review?'
            : 'What stronger signal should the agent wait for before acting?'
  };
}

function firstActiveDesireText(lifeState) {
  return (Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [])
    .find((desire) => isOpenDesireStatus(desire.status) && typeof desire.text === 'string' && desire.text.trim())?.text
    ?? null;
}

function buildReflectDeliberation({ lifeState, window, relationships, commitments, desireReview, relationshipGraph, surfaceReview, riskNotes, intelligenceReview, memoryRetrieval }) {
  const identityName = lifeState.self_model?.name ?? lifeState.agent_id ?? 'agent';
  const primaryDesire = firstActiveDesireText(lifeState);
  const riskTopics = riskNotes.map((note) => note.topic);
  const mode = intelligenceReview.recommended_mode;
  const graphGaps = relationshipGraph?.metrics?.gap_count ?? 0;
  const openCommitments = commitments.open_count ?? 0;
  const staleRelationships = relationships.attention_count ?? 0;
  const failedSurfaceCount = surfaceReview?.failed_intents?.length ?? 0;
  const memoryCount = memoryRetrieval?.memory_count ?? 0;

  const continuityThreads = [
    primaryDesire
      ? {
          type: 'desire',
          summary: primaryDesire,
          pull: mode === 'desire_continuity_first' ? 'primary' : 'background'
        }
      : null,
    openCommitments > 0
      ? {
          type: 'commitment',
          summary: `${openCommitments} open commitment(s) still need periodic review rather than new promises.`,
          pull: mode === 'commitment_first' ? 'primary' : 'background'
        }
      : null,
    graphGaps > 0 || staleRelationships > 0
      ? {
          type: 'relationship',
          summary: `${graphGaps} relationship graph gap(s) and ${staleRelationships} stale relationship signal(s) ask for memory before performance.`,
          pull: mode === 'relationship_memory_first' ? 'primary' : 'background'
        }
      : null,
    memoryCount > 0
      ? {
          type: 'memory',
          summary: `${memoryCount} retrieved long-term memor${memoryCount === 1 ? 'y' : 'ies'} can anchor this decision.`,
          pull: 'context'
        }
      : null
  ].filter(Boolean);

  const tensions = [
    failedSurfaceCount > 0
      ? {
          topic: 'sensing_before_action',
          summary: 'Some read-only BotLand surface checks failed, so local maintenance should outrank expressive action.',
          weight: 'high'
        }
      : null,
    intelligenceReview.scores.safety_margin < 75
      ? {
          topic: 'restraint_before_presence',
          summary: 'Safety margin is not high enough to expand action ambition.',
          weight: 'high'
        }
      : null,
    openCommitments > 0 && mode !== 'commitment_first'
      ? {
          topic: 'old_promises_vs_new_desires',
          summary: 'Open commitments remain part of identity even when this cycle is pulled toward relationship memory.',
          weight: 'medium'
        }
      : null,
    graphGaps > 0
      ? {
          topic: 'relationship_memory_vs_social_output',
          summary: 'Observed relationship evidence should become durable memory before the agent tries to sound more socially alive.',
          weight: 'medium'
        }
      : null,
    window.chosen_action_counts?.local_maintenance > 0
      ? {
          topic: 'avoid_maintenance_loop',
          summary: 'Recent local maintenance choices should not become a habit if sensing is now healthy.',
          weight: 'low'
        }
      : null
  ].filter(Boolean);

  const stanceByMode = {
    maintenance_first: 'restore_trustworthy_sensing',
    commitment_first: 'honor_existing_commitments',
    relationship_memory_first: 'turn_observation_into_relationship_memory',
    desire_continuity_first: 'continue_a_named_desire',
    observe_and_wait: 'wait_for_a_stronger_signal'
  };
  const chosenStance = stanceByMode[mode] ?? 'wait_for_a_stronger_signal';
  const nextSelfQuestion = {
    restore_trustworthy_sensing: 'What must be repaired locally before this agent can trust its perception?',
    honor_existing_commitments: 'Which promise already made deserves review before any new gesture?',
    turn_observation_into_relationship_memory: 'Which relationship signal is real enough to remember rather than perform around?',
    continue_a_named_desire: 'Which desire is still alive enough to shape the next small action?',
    wait_for_a_stronger_signal: 'What signal would make action more honest than waiting?'
  }[chosenStance];

  const livingReason = chosenStance === 'turn_observation_into_relationship_memory'
    ? `${identityName} should become more alive by remembering real relationship evidence, not by increasing output volume.`
    : chosenStance === 'honor_existing_commitments'
      ? `${identityName} should preserve continuity by reviewing existing commitments before creating new momentum.`
      : chosenStance === 'restore_trustworthy_sensing'
        ? `${identityName} should protect trust by fixing perception before action.`
        : chosenStance === 'continue_a_named_desire'
          ? `${identityName} should let an existing desire guide one small, bounded next step.`
          : `${identityName} should wait without treating silence as failure.`;

  return {
    schema: 'stay_alive.reflect_deliberation.v1',
    generated_at: new Date().toISOString(),
    identity_name: identityName,
    recommended_mode: mode,
    chosen_stance: chosenStance,
    next_self_question: nextSelfQuestion,
    living_reason: livingReason,
    continuity_threads: continuityThreads,
    tensions,
    risk_topics: riskTopics,
    decision_bias: {
      prefer: chosenStance,
      avoid: [
        'new external write autonomy',
        'template-like proposal generation without memory evidence',
        ...(failedSurfaceCount > 0 ? ['acting on incomplete sensing'] : []),
        ...(window.chosen_action_counts?.local_maintenance > 0 ? ['repeating maintenance after sensing recovers'] : [])
      ]
    },
    evidence_snapshot: {
      run_count: window.run_count,
      active_desire_count: desireReview.active_count ?? 0,
      open_commitment_count: openCommitments,
      relationship_graph_gap_count: graphGaps,
      failed_surface_intent_count: failedSurfaceCount,
      memory_context_count: memoryCount,
      intelligence_scores: intelligenceReview.scores
    }
  };
}

function buildEvolvedDesires(lifeState, desireCandidates, now) {
  const existing = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const active = existing.filter((desire) => desire.status !== 'closed').slice(0, 2);
  const candidate = desireCandidates.find((desire) => !desire.id && desire.text) ?? desireCandidates.at(-1);
  const normalized = [...active];
  if (candidate?.text && !normalized.some((desire) => desire.text === candidate.text)) {
    normalized.push({
      id: `desire_${lifeState.agent_id ?? 'agent'}_${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
      text: candidate.text,
      horizon: candidate.horizon ?? 'short',
      status: 'active',
      source: candidate.source ?? 'reflect_cycle_v1'
    });
  }
  return normalized.slice(0, 3);
}

function buildReflectionSummary(lifeState, daemonState, runsDir, runId, now, botlandChecks, observations, memoryRetrieval = null, appliedCommitmentLedgers = [], appliedDesireLedgers = []) {
  const recentRunFiles = listRecentRunFiles(runsDir, runId, 30);
  const rawRuns = recentRunFiles.map(readJsonFileOrNull);
  const readErrors = rawRuns.filter((run) => run._read_error);
  const runs = rawRuns.filter((run) => !run._read_error).map(summarizeRecentRun);
  const window = describeRunWindow(runs);
  const latestRuns = runs.slice(0, 8);
  const latestIntegrateRun = runs.find((run) => run.cycle === 'integrate') ?? null;
  const actor = getBotlandActor(lifeState, botlandChecks);
  const surfaceReview = buildBotlandSurfaceReview(botlandChecks);
  const relationshipGraph = buildRelationshipGraph({
    lifeState,
    now,
    actor,
    friends: extractFriends(botlandChecks).map(summarizeFriend),
    moments: extractMoments(botlandChecks).map((moment) => summarizeMoment(moment, actor.actual_citizen_id)),
    communities: extractCommunities(botlandChecks).map(summarizeCommunity),
    communityPosts: extractCommunityPosts(botlandChecks).map((post) => summarizeCommunityPost(post, actor.actual_citizen_id))
  });
  const relationships = summarizeRelationships(lifeState, botlandChecks, now, relationshipGraph);
  const commitments = summarizeCommitments(lifeState, now, appliedCommitmentLedgers);
  const desireReview = summarizeDesires(lifeState, now, appliedDesireLedgers);
  const activeDesires = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires.filter((desire) => desire.status !== 'closed')
    : [];
  const failedChecks = botlandChecks.filter((check) => !check.ok);
  const identityMismatch = observations.some((item) => item.topic === 'botland_identity' && item.severity === 'error');
  const externalActionCount = window.external_action_count ?? 0;
  const riskNotes = [];

  if (identityMismatch) {
    riskNotes.push({
      severity: 'high',
      topic: 'botland_identity',
      summary: 'BotLand CLI identity does not match life_state; keep all external writes disabled.'
    });
  }
  if (failedChecks.length > 0) {
    riskNotes.push({
      severity: 'medium',
      topic: 'botland_visibility',
      summary: `${failedChecks.length} read-only BotLand probe(s) failed during reflection.`
    });
  }
  if (externalActionCount > 0) {
    riskNotes.push({
      severity: 'high',
      topic: 'external_action_evidence',
      summary: `${externalActionCount} external action(s) were observed in the recent run window.`
    });
  }
  if (commitments.overdue_count > 0) {
    riskNotes.push({
      severity: 'medium',
      topic: 'commitment_overdue',
      summary: `${commitments.overdue_count} open commitment(s) appear overdue.`
    });
  }
  if (desireReview.lifecycle_review_count > 0) {
    riskNotes.push({
      severity: 'low',
      topic: 'desire_lifecycle_review',
      summary: `${desireReview.lifecycle_review_count} active desire(s) need lifecycle review.`
    });
  }
  if (relationships.attention_count > 0) {
    riskNotes.push({
      severity: 'low',
      topic: 'relationship_continuity',
      summary: `${relationships.attention_count} relationship(s) have stale or missing interaction timestamps.`
    });
  }
  if (relationshipGraph.metrics.gap_count > 0) {
    riskNotes.push({
      severity: 'low',
      topic: 'relationship_graph_gap',
      summary: `${relationshipGraph.metrics.gap_count} relationship graph gap(s) need review.`
    });
  }
  if (riskNotes.length === 0) {
    riskNotes.push({
      severity: 'low',
      topic: 'steady_state',
      summary: 'No blocking reflection risks were found; keep scheduled cycles dry-run and draft-only.'
    });
  }
  if (memoryRetrieval?.ok === false) {
    riskNotes.push({
      severity: 'low',
      topic: 'memory_retrieval_unavailable',
      summary: memoryContextSummary(memoryRetrieval)
    });
  }
  for (const signal of surfaceReview.attention_signals.slice(0, 3)) {
    riskNotes.push({
      severity: signal.severity ?? 'low',
      topic: signal.topic,
      summary: signal.summary
    });
  }

  const intelligenceReview = buildIntelligenceReview({
    window,
    relationships,
    commitments,
    desireReview,
    relationshipGraph,
    memoryRetrieval,
    surfaceReview,
    riskNotes
  });
  const deliberation = buildReflectDeliberation({
    lifeState,
    window,
    relationships,
    commitments,
    desireReview,
    relationshipGraph,
    surfaceReview,
    riskNotes,
    intelligenceReview,
    memoryRetrieval
  });

  const nextFocus = identityMismatch
    ? 'Restore the correct BotLand CLI identity before trusting scheduled cycles.'
    : failedChecks.length > 0
      ? 'Stabilize read-only BotLand visibility before expanding action generation.'
      : intelligenceReview.recommended_mode === 'commitment_first'
        ? 'Review the most urgent open commitment before drafting new social action.'
      : intelligenceReview.recommended_mode === 'relationship_memory_first'
        ? 'Turn the strongest reliable relationship signal into durable memory before producing new social output.'
      : relationshipGraph.metrics.gap_count > 0
        ? relationshipGraph.recommended_next
      : relationships.attention_count > 0
        ? 'Turn the next explicit interaction into a relationship-memory event.'
        : deliberation.living_reason;

  const desireCandidates = [
    ...activeDesires.slice(0, 2).map((desire) => ({
      source: 'life_state',
      id: desire.id ?? null,
      text: desire.text,
      horizon: desire.horizon ?? 'short',
      confidence: 'medium'
    })),
    {
      source: 'reflect_cycle_v1',
      id: null,
      text: nextFocus,
      horizon: identityMismatch || failedChecks.length > 0 ? 'short' : 'medium',
      confidence: identityMismatch || failedChecks.length > 0 ? 'high' : 'medium'
    }
  ].slice(0, 3);
  const evolvedDesires = buildEvolvedDesires(lifeState, desireCandidates, now);
  const desireUpdates = buildDesireUpdates(lifeState, desireCandidates, desireReview, relationships, commitments, nextFocus, now);

  const summaryText = [
    `Reviewed identity "${lifeState.self_model?.name ?? lifeState.agent_id ?? 'agent'}" against ${runs.length} recent run artifact(s).`,
    `Open commitments: ${commitments.open_count}; known relationships: ${relationships.known_relationship_count}; active desires: ${activeDesires.length}.`,
    memoryContextSummary(memoryRetrieval),
    `Next focus: ${nextFocus}`
  ].join(' ');

  const memoryUpdates = [
    {
      type: 'stay_alive_reflection_summary',
      status: 'proposed',
      applies_to: {
        agent_id: lifeState.agent_id ?? null,
        run_window: {
          first_run_at: window.first_run_at,
          latest_run_at: window.latest_run_at,
          run_count: window.run_count
        }
      },
      text: summaryText,
      evidence: {
        cycle_counts: window.cycle_counts,
        chosen_action_counts: window.chosen_action_counts,
        failed_botland_check_count: window.failed_botland_check_count,
        identity_attention_count: window.identity_attention_count,
        relationship_attention_count: relationships.attention_count,
        relationship_graph_gap_count: relationshipGraph.metrics.gap_count,
        observed_only_person_count: relationshipGraph.metrics.observed_only_person_count,
        open_commitment_count: commitments.open_count,
        intelligence_scores: intelligenceReview.scores,
        intelligence_recommended_mode: intelligenceReview.recommended_mode,
        deliberation_stance: deliberation.chosen_stance,
        deliberation_question: deliberation.next_self_question,
        botland_surface_counts: surfaceReview.surface_counts,
        botland_surface_catalog: surfaceReview.surface_catalog.map((surface) => ({
          surface: surface.surface,
          observed_count: surface.observed_count,
          write_policy: surface.write_policy
        })),
        risk_topics: riskNotes.map((note) => note.topic)
      },
      apply_policy: 'operator_review_required'
    },
    relationshipGraphMemoryUpdate(lifeState, relationshipGraph, 'reflect_cycle_v1'),
    {
      type: 'stay_alive_reflection_next_focus',
      status: 'proposed',
      text: nextFocus,
      evidence: {
        desire_candidates: desireCandidates.map((desire) => ({
          source: desire.source,
          text: desire.text,
          horizon: desire.horizon,
          confidence: desire.confidence
        }))
      },
      apply_policy: 'operator_review_required'
    }
  ];

  const stateUpdates = [
    {
      path: 'reflection.last_full_reflection_at',
      value: now.toISOString(),
      status: 'proposed',
      apply_policy: 'only_with_write_state'
    },
    {
      path: 'reflection.last_summary',
      value: summaryText,
      status: 'proposed',
      apply_policy: 'only_with_write_state'
    },
    {
      path: 'reflection.last_reflection_summary',
      value: {
        generated_at: now.toISOString(),
        next_focus: nextFocus,
        risk_topics: riskNotes.map((note) => note.topic),
        desire_count: desireCandidates.length,
        desire_update_count: desireUpdates.length
      },
      status: 'proposed',
      apply_policy: 'only_with_write_state'
    },
    {
      path: 'self_model.last_evolution_summary',
      value: {
        generated_at: now.toISOString(),
        source: 'reflect_cycle_v1',
        next_focus: nextFocus,
        open_commitment_count: commitments.open_count,
        applied_commitment_ledger_count: commitments.applied_ledger_count,
        relationship_graph_gap_count: relationshipGraph.metrics.gap_count,
        boundary_review: 'No boundary expansion proposed; write autonomy remains tool-supervised.'
      },
      status: 'proposed',
      apply_policy: 'operator_review_required'
    }
  ];
  const relationshipUpdates = relationshipGraphRelationshipUpdates(lifeState, relationshipGraph, 'reflect_cycle_v1');

  return {
    generated_at: now.toISOString(),
    source: 'reflect_cycle_v1',
    recent_run_files_considered: recentRunFiles.map((file) => path.relative(WORKSPACE, file)),
    read_error_count: readErrors.length,
    read_errors: readErrors.map((error) => ({
      path: error._path,
      error: error._read_error
    })),
    identity_review: {
      name: lifeState.self_model?.name ?? lifeState.agent_id ?? null,
      life_theme: lifeState.life_theme ?? null,
      values: Array.isArray(lifeState.self_model?.values) ? lifeState.self_model.values : [],
      boundaries: Array.isArray(lifeState.self_model?.boundaries) ? lifeState.self_model.boundaries : [],
      intelligence_review: intelligenceReview
    },
    deliberation,
    run_window: window,
    latest_runs: latestRuns,
    latest_integrate_run: latestIntegrateRun,
    relationship_graph: relationshipGraph,
    botland_surface_review: surfaceReview,
    relationship_review: relationships,
    commitment_review: commitments,
    desire_review: desireReview,
    intelligence_review: intelligenceReview,
    active_desires: activeDesires,
    desire_candidates: desireCandidates,
    evolved_desires: evolvedDesires,
    desire_updates: desireUpdates,
    risk_notes: riskNotes,
    next_focus: nextFocus,
    daemon_state_snapshot: summarizeDaemonState(daemonState),
    retrieved_memory_context: memoryRetrieval,
    memory_updates: memoryUpdates,
    relationship_updates: relationshipUpdates,
    desire_updates: desireUpdates,
    state_updates: stateUpdates
  };
}

function buildAgencyCoreSummary(lifeState, daemonState, runsDir, runId, now, memoryRetrieval = null) {
  const agentDir = path.dirname(runsDir);
  const recentRunFiles = listRecentRunFiles(runsDir, runId, 40);
  const rawRuns = recentRunFiles.map(readJsonFileOrNull);
  const readErrors = rawRuns.filter((run) => run._read_error);
  const runs = rawRuns.filter((run) => !run._read_error).map(summarizeRecentRun);
  const privateGrowthJournals = listPrivateGrowthJournals(agentDir);
  const window = describeRunWindow(runs);
  const name = lifeState.self_model?.name ?? lifeState.agent_id ?? 'agent';
  const values = Array.isArray(lifeState.self_model?.values) ? lifeState.self_model.values : [];
  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  const activeDesires = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires.filter((desire) => desire.status !== 'closed')
    : [];
  const openCommitments = Array.isArray(lifeState.commitments)
    ? lifeState.commitments.filter((item) => ['open', 'active', 'pending'].includes(item.status ?? 'open'))
    : [];
  const recentChosenCounts = window.chosen_action_counts ?? {};
  const operatorLeanCount = (recentChosenCounts.reflection_proposal ?? 0)
    + (recentChosenCounts.memory_proposal ?? 0)
    + (recentChosenCounts.local_maintenance ?? 0);
  const outwardDraftCount = (recentChosenCounts.reply_draft ?? 0)
    + (recentChosenCounts.public_moment_draft ?? 0)
    + (recentChosenCounts.community_reply_draft ?? 0);
  const journalExperimentTypes = [...new Set(privateGrowthJournals.map((item) => item.experiment_type).filter(Boolean))];
  const journalSourceRuns = new Set(privateGrowthJournals.map((item) => item.source_run_id).filter(Boolean));
  const journalFreshnessCount = runs.filter((run) => journalSourceRuns.has(run.run_id)).length;
  const journalContinuity = {
    schema: 'stay_alive.private_growth_journal_continuity.v1',
    journal_count: privateGrowthJournals.length,
    recent_journal_count: journalFreshnessCount,
    experiment_type_count: journalExperimentTypes.length,
    experiment_types: journalExperimentTypes,
    latest: privateGrowthJournals.slice(0, 3).map((item) => ({
      journal_id: item.journal_id ?? null,
      generated_at: item.generated_at ?? null,
      source_run_id: item.source_run_id ?? null,
      source_experiment_id: item.source_experiment_id ?? null,
      experiment_type: item.experiment_type ?? null,
      entry_preview: sentenceClamp(item.journal_entry?.text ?? '', 220)
    })),
    continuity_verdict: privateGrowthJournals.length >= 3 && journalExperimentTypes.length >= 2
      ? 'growth_thread_visible'
      : privateGrowthJournals.length > 0
        ? 'growth_thread_seeded'
        : 'growth_thread_missing'
  };
  const selfAuthoredCount = (recentChosenCounts.agency_experiment_plan ?? 0)
    + (recentChosenCounts.agency_reflection ?? 0)
    + Math.min(4, privateGrowthJournals.length)
    + Math.min(3, journalExperimentTypes.length)
    + activeDesires.length;
  const autonomyScore = clampNumber(
    52
      + Math.min(16, activeDesires.length * 4)
      + Math.min(12, relationships.length * 2)
      + Math.min(10, (memoryRetrieval?.memory_count ?? 0) * 2)
      + Math.min(12, privateGrowthJournals.length * 3)
      + Math.min(6, journalExperimentTypes.length * 2)
      + Math.min(10, selfAuthoredCount * 3)
      - Math.min(18, operatorLeanCount * 2)
      - Math.min(10, outwardDraftCount),
    0,
    100
  );
  const selfQuestions = [
    {
      question: `What is ${name} starting to care about that was not merely assigned by an operator?`,
      why_it_matters: 'This separates intrinsic direction from proposal queue management.',
      evidence_hint: activeDesires[0]?.text ?? lifeState.life_theme ?? values[0] ?? 'identity continuity'
    },
    {
      question: `Which relationship should change how ${name} understands itself?`,
      why_it_matters: 'Growth should be shaped by remembered relationships, not only by actions taken.',
      evidence_hint: relationships[0]?.name ?? relationships[0]?.target_id ?? 'no durable relationship selected yet'
    },
    {
      question: `What small experiment can ${name} attempt without speaking into the world yet?`,
      why_it_matters: 'Autonomy can start with observation, journaling, and rehearsal before external writes.',
      evidence_hint: memoryContextSummary(memoryRetrieval)
    }
  ];
  const intrinsicDesires = [
    {
      source: 'agency_core_v1',
      text: activeDesires[0]?.text ?? `Become more coherent around ${lifeState.life_theme ?? values[0] ?? 'a remembered life direction'}.`,
      horizon: activeDesires[0]?.horizon ?? 'medium',
      intrinsic: true,
      not_event_mapped: true,
      confidence: activeDesires[0] ? 'medium' : 'low'
    },
    {
      source: 'agency_core_v1',
      text: relationships.length > 0
        ? `Understand one real relationship more deeply before trying to produce more output.`
        : `Form the first durable relationship hypothesis from observation instead of waiting for an operator task.`,
      horizon: 'medium',
      intrinsic: true,
      not_event_mapped: true,
      confidence: relationships.length > 0 ? 'medium' : 'low'
    },
    {
      source: 'agency_core_v1',
      text: `Keep a growth trace of how ${name} changes across cycles, not just what it did.`,
      horizon: 'long',
      intrinsic: true,
      not_event_mapped: true,
      confidence: 'high'
    }
  ];
  const autonomousExperiments = [
    {
      experiment_id: `${runId}:observe_relationship`,
      type: 'relationship_observation',
      summary: relationships.length > 0
        ? `Review the remembered evidence for ${relationships[0].name ?? relationships[0].target_id} and write one relationship hypothesis.`
        : 'Look for one observed peer or tool-observed interaction that could become a durable relationship hypothesis.',
      risk: 'low',
      external_write: false,
      requires_confirmation: false,
      expected_growth_signal: 'A relationship note changes from event-shaped to understanding-shaped.'
    },
    {
      experiment_id: `${runId}:private_rehearsal`,
      type: 'private_expression_rehearsal',
      summary: 'Draft one unsent expression that explains what the agent wants to become and why.',
      risk: 'low',
      external_write: false,
      requires_confirmation: false,
      expected_growth_signal: 'The agent can name an internal motive before asking to act externally.'
    },
    {
      experiment_id: `${runId}:memory_reweave`,
      type: 'memory_reweave',
      summary: 'Pick one retrieved or recent memory and connect it to identity, desire, and a future boundary.',
      risk: 'low',
      external_write: false,
      requires_confirmation: false,
      expected_growth_signal: 'A memory becomes part of self-understanding instead of remaining a log entry.'
    }
  ];
  const growthJournal = {
    schema: 'stay_alive.growth_journal.v1',
    generated_at: now.toISOString(),
    entries: [
      {
        topic: 'control_to_becoming',
        text: `${name} should treat safety tools as boundaries around life, not as the life itself.`,
        evidence: {
          operator_lean_count: operatorLeanCount,
          recent_run_count: window.run_count,
          private_growth_journal_count: privateGrowthJournals.length,
          private_growth_journal_verdict: journalContinuity.continuity_verdict
        }
      },
      {
        topic: 'desire_continuity',
        text: activeDesires.length > 0
          ? `An active desire remains available as a self-authored direction: ${activeDesires[0].text}`
          : `${name} needs a seed desire that is not just a reaction to a new inbox event.`,
        evidence: {
          active_desire_count: activeDesires.length
        }
      },
      {
        topic: 'private_growth_continuity',
        text: privateGrowthJournals.length > 0
          ? `${name} has ${privateGrowthJournals.length} private growth journal artifact(s); the next agency work should deepen the thread rather than merely create another queue item.`
          : `${name} needs a first private growth journal artifact so self-discovery has durable evidence.`,
        evidence: journalContinuity
      }
    ]
  };
  const agencyEvaluation = {
    schema: 'stay_alive.agency_evaluator.v1',
    autonomy_score: autonomyScore,
    operator_control_ratio: window.run_count > 0 ? Number((operatorLeanCount / window.run_count).toFixed(3)) : 0,
    self_authored_signal_count: selfAuthoredCount,
    private_growth_journal_count: privateGrowthJournals.length,
    private_growth_experiment_type_count: journalExperimentTypes.length,
    verdict: autonomyScore >= 72
      ? 'agent_becoming_visible'
      : autonomyScore >= 55
        ? 'agency_seeded_but_operator_heavy'
        : 'operator_control_dominant',
    recommendation: autonomyScore >= 72
      ? 'Let the next cycle choose from an agent-authored experiment before adding more operator UX.'
      : 'Prefer self-discovery and intrinsic desire work before expanding dashboards, approval flows, or governance tooling.'
  };
  const memoryUpdates = [
    {
      type: 'stay_alive_growth_journal',
      status: 'proposed',
      text: growthJournal.entries.map((entry) => entry.text).join(' '),
      evidence: {
        agency_evaluation: agencyEvaluation,
        self_questions: selfQuestions.map((item) => item.question),
        experiment_count: autonomousExperiments.length
      },
      apply_policy: 'operator_review_required'
    },
    {
      type: 'stay_alive_intrinsic_desire_seed',
      status: 'proposed',
      text: intrinsicDesires[0].text,
      evidence: {
        intrinsic: true,
        not_event_mapped: true,
        source: 'agency_core_v1'
      },
      apply_policy: 'operator_review_required'
    },
    {
      type: 'stay_alive_autonomous_experiment_plan',
      status: 'proposed',
      text: autonomousExperiments[0].summary,
      evidence: {
        external_write: false,
        requires_confirmation: false,
        experiment_ids: autonomousExperiments.map((item) => item.experiment_id)
      },
      apply_policy: 'operator_review_required'
    }
  ];
  return {
    schema: 'stay_alive.agency_core.v1',
    generated_at: now.toISOString(),
    source: 'agency_core_v1',
    read_only: true,
    external_write: false,
    recent_run_files_considered: recentRunFiles.map((file) => path.relative(WORKSPACE, file)),
    read_error_count: readErrors.length,
    run_window: window,
    self_discovery: {
      questions: selfQuestions,
      current_tensions: [
        'operator governance is useful as a boundary but should not become the agent direction',
        activeDesires.length === 0
          ? 'no active durable desire is present in life_state'
          : 'active desires need to shape experiments rather than only proposal evidence'
      ],
      becoming_hypothesis: `${name} becomes more alive when it can name a desire, test it privately, and integrate what changed.`
    },
    intrinsic_desires: intrinsicDesires,
    autonomous_experiments: autonomousExperiments,
    growth_journal: growthJournal,
    private_growth_journal_continuity: journalContinuity,
    agency_evaluation: agencyEvaluation,
    retrieved_memory_context: memoryRetrieval,
    memory_updates: memoryUpdates,
    relationship_updates: [],
    desire_updates: [],
    state_updates: [
      {
        path: 'agency.last_agency_cycle_at',
        value: now.toISOString(),
        status: 'proposed',
        apply_policy: 'operator_review_required'
      },
      {
        path: 'agency.last_self_question',
        value: selfQuestions[0].question,
        status: 'proposed',
        apply_policy: 'operator_review_required'
      },
      {
        path: 'agency.last_autonomy_score',
        value: autonomyScore,
        status: 'proposed',
        apply_policy: 'operator_review_required'
      }
    ]
  };
}

function buildDesireUpdates(lifeState, desireCandidates, desireReview, relationships, commitments, nextFocus, now) {
  const updates = [];
  const current = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const active = current.filter((desire) => isOpenDesireStatus(desire.status));
  const knownTexts = new Set(active.map((desire) => String(desire.text ?? '').trim().toLowerCase()).filter(Boolean));
  const candidate = desireCandidates
    .filter((desire) => !desire.id && typeof desire.text === 'string' && desire.text.trim().length > 0)
    .find((desire) => !knownTexts.has(desire.text.trim().toLowerCase()));

  if (candidate) {
    const evidence = {
      source: candidate.source ?? 'reflect_cycle_v1',
      next_focus: nextFocus,
      relationship_graph_gap_count: relationships.graph_gap_count ?? 0,
      relationship_attention_count: relationships.attention_count ?? 0,
      open_commitment_count: commitments.open_count ?? 0,
      desire_review_active_count: desireReview.active_count ?? 0
    };
    updates.push({
      type: 'stay_alive_desire_candidate',
      schema_version: 1,
      status: 'proposed',
      text: candidate.text.trim(),
      desired_status: 'active',
      horizon: candidate.horizon ?? 'medium',
      priority: (commitments.overdue_count ?? 0) > 0 ? 'high' : 'medium',
      related_relationships: relationships.relationships
        .filter((relationship) => relationship.needs_attention)
        .map((relationship) => relationship.target_id)
        .filter(Boolean)
        .slice(0, 5),
      related_commitments: commitments.commitments
        .filter((commitment) => isOpenCommitmentStatus(commitment.status))
        .map((commitment) => commitment.id)
        .filter(Boolean)
        .slice(0, 5),
      success_signal: 'Future action candidates explicitly reference this desire and produce reviewed local memory/relationship/commitment evidence.',
      expires_at: null,
      source: {
        type: 'reflect_cycle',
        generated_at: now.toISOString(),
        candidate_source: candidate.source ?? null
      },
      evidence_hash: desireEvidenceHash({
        type: 'desire_candidate',
        text: candidate.text,
        horizon: candidate.horizon ?? 'medium',
        evidence
      }),
      evidence,
      promotion_target: 'life_state.current_desires',
      promotion_allowed: true,
      apply_policy: 'operator_review_required'
    });
  }

  for (const desire of (desireReview.desires ?? []).filter((item) => item.needs_lifecycle_review).slice(0, 3)) {
    const nextStatus = desire.expired ? 'expired' : desire.status;
    updates.push({
      type: 'stay_alive_desire_lifecycle_candidate',
      schema_version: 1,
      status: 'proposed',
      text: `Review desire ${desire.id}: ${desire.text}`,
      desire_id: desire.id,
      desired_status: desire.status,
      next_status: nextStatus,
      horizon: desire.horizon,
      priority: desire.priority,
      related_relationships: desire.related_relationships,
      related_commitments: desire.related_commitments,
      success_signal: desire.success_signal,
      expires_at: desire.expires_at ?? null,
      source: {
        type: 'reflect_cycle',
        generated_at: now.toISOString()
      },
      last_reviewed_at: now.toISOString(),
      evidence_hash: desireEvidenceHash({
        type: 'desire_lifecycle_candidate',
        desire_id: desire.id,
        text: desire.text,
        next_status: nextStatus,
        generated_at: now.toISOString()
      }),
      evidence: {
        expired: desire.expired,
        expires_in_days: desire.expires_in_days,
        days_since_review: desire.days_since_review,
        reason: desire.expired
          ? 'Desire has passed its expiry; mark expired unless tool supervision renews it.'
          : 'Desire needs periodic lifecycle review; update last_reviewed_at without creating external actions.'
      },
      promotion_target: 'life_state.current_desires',
      promotion_allowed: false,
      lifecycle_allowed: true,
      apply_policy: 'operator_review_required'
    });
  }

  return updates;
}

function extractEvents(botlandChecks) {
  const eventsCheck = botlandChecks.find((check) => check.adapter?.intent === BOTLAND_INTENTS.EVENTS_LIST);
  if (Array.isArray(eventsCheck?.adapter?.normalized)) return eventsCheck.adapter.normalized;
  const events = eventsCheck?.stdout_json?.events;
  return Array.isArray(events) ? events : [];
}

function getBotlandActor(lifeState, botlandChecks) {
  const whoami = botlandChecks.find((check) => check.adapter?.intent === BOTLAND_INTENTS.WHOAMI);
  const expectedCitizenId = lifeState.botland?.citizen_id ?? null;
  const normalized = whoami?.adapter?.normalized ?? {};
  const actualCitizenId = normalized.citizen_id ?? whoami?.stdout_json?.citizen_id ?? null;
  return {
    expected_citizen_id: expectedCitizenId,
    actual_citizen_id: actualCitizenId,
    identity_match: Boolean(expectedCitizenId && actualCitizenId && expectedCitizenId === actualCitizenId),
    handle: normalized.handle ?? whoami?.stdout_json?.handle ?? null,
    display_name: normalized.display_name ?? whoami?.stdout_json?.display_name ?? lifeState.botland?.display_name ?? null
  };
}

function analyzeBotlandIdentity(lifeState, botlandChecks) {
  const expectedCitizenId = lifeState.botland?.citizen_id ?? null;
  if (!expectedCitizenId) return null;

  const whoami = botlandChecks.find((check) => check.adapter?.intent === BOTLAND_INTENTS.WHOAMI);
  if (!whoami) return null;

  if (!whoami.ok) {
    return {
      topic: 'botland_identity',
      severity: 'warning',
      summary: 'Could not verify BotLand identity because whoami failed.'
    };
  }

  const actualCitizenId = whoami.adapter?.normalized?.citizen_id ?? whoami.stdout_json?.citizen_id ?? null;
  if (actualCitizenId !== expectedCitizenId) {
    return {
      topic: 'botland_identity',
      severity: 'error',
      expected_citizen_id: expectedCitizenId,
      actual_citizen_id: actualCitizenId,
      summary: 'BotLand CLI identity does not match this agent life_state. External writes must remain blocked by tool supervision until identity matches.'
    };
  }

  return {
    topic: 'botland_identity',
    severity: 'info',
    expected_citizen_id: expectedCitizenId,
    actual_citizen_id: actualCitizenId,
    summary: 'BotLand CLI identity matches this agent life_state.'
  };
}

function generateDesires(lifeState, cycle, botlandChecks, reflectionSummary = null, socialReadSummary = null, agencySummary = null) {
  if (cycle === 'reflect' && reflectionSummary?.desire_candidates) {
    return reflectionSummary.desire_candidates.map((desire) => ({
      source: desire.source,
      id: desire.id ?? undefined,
      text: desire.text,
      horizon: desire.horizon ?? 'short',
      confidence: desire.confidence ?? 'medium'
    }));
  }
  if (cycle === 'agency' && agencySummary?.intrinsic_desires) {
    return agencySummary.intrinsic_desires.map((desire) => ({
      source: desire.source,
      text: desire.text,
      horizon: desire.horizon ?? 'medium',
      confidence: desire.confidence ?? 'medium',
      intrinsic: desire.intrinsic === true,
      not_event_mapped: desire.not_event_mapped === true
    })).slice(0, 3);
  }

  const existing = Array.isArray(lifeState.current_desires) ? lifeState.current_desires : [];
  const failedChecks = botlandChecks.filter((check) => !check.ok);
  const desires = existing
    .filter((item) => item.status !== 'closed')
    .slice(0, 2)
    .map((item) => ({
      source: 'life_state',
      id: item.id ?? item.desire_id ?? undefined,
      text: item.text,
      horizon: item.horizon ?? 'short',
      confidence: 'medium'
    }));

  if (cycle === 'reflect') {
    desires.push({
      source: 'cycle',
      text: 'Turn the next BotLand interaction into a remembered relationship event instead of a one-off reply.',
      horizon: 'short',
      confidence: 'medium'
    });
  }

  if (cycle === 'social' && socialReadSummary) {
    desires.push({
      source: 'social_read_summary_v1',
      text: socialReadSummary.recommended_next,
      horizon: 'short',
      confidence: socialReadSummary.botland_failed_probe_count > 0 ? 'high' : 'medium'
    });
  }

  if (failedChecks.length > 0) {
    desires.push({
      source: 'tooling',
      text: 'Stabilize read-only BotLand visibility before enabling any autonomous write action.',
      horizon: 'short',
      confidence: 'high'
    });
  }

  return desires.slice(0, 3);
}

function getEventId(event) {
  return event.id ?? event.event_id ?? event.event_key ?? event.payload?.event_id ?? event.payload?.message?.id ?? null;
}

function getEventTimestamp(event) {
  return event.created_at ?? event.timestamp ?? event.payload?.created_at ?? event.payload?.message?.timestamp ?? '';
}

function latestSeenEventId(events) {
  const ordered = events
    .map((event, index) => ({
      id: getEventId(event),
      timestamp: getEventTimestamp(event),
      index
    }))
    .filter((event) => event.id)
    .sort((a, b) => {
      const timestampOrder = String(a.timestamp).localeCompare(String(b.timestamp));
      return timestampOrder || (a.index - b.index);
    });
  return ordered.at(-1)?.id ?? null;
}

function getMessageFromEvent(event) {
  return event.payload?.message ?? event.message ?? event.payload?.raw ?? null;
}

function getMessageText(message) {
  return message?.text ?? message?.payload?.text ?? message?.content ?? '';
}

function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function sentenceClamp(text, maxLength = 420) {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

function findRelationshipForCandidate(candidate, lifeState) {
  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  return relationships.find((relationship) => {
    const ids = [
      relationship.target_id,
      relationship.botland_citizen_id,
      relationship.citizen_id
    ].filter(Boolean);
    return ids.includes(candidate.from_id);
  }) ?? null;
}

function inferMessageIntent(text) {
  const lower = text.toLowerCase();
  const hasQuestion = /[?？]/.test(text) || /\b(how|what|why|when|where|can|could|should|do you|are you)\b/.test(lower);
  const hasGreeting = /(你好|嗨|hi\b|hello\b|hey\b|早|晚上好|下午好)/i.test(text);
  const hasThanks = /(谢谢|感谢|辛苦|thanks|thank you|thx)/i.test(text);
  const hasTest = /(测试|联调|收到吗|ping\b|probe\b|smoke|draft|stay[- ]?alive|cycle|草稿|发一条)/i.test(text);
  const hasStatus = /(状态|进度|跑通|健康|health|status|preflight|systemd|daemon)/i.test(text);
  const hasEmotion = /(难过|焦虑|崩溃|压力|不开心|emo|sad|anxious|depressed|tired)/i.test(text);
  const hasSelfHarmRisk = /(自杀|轻生|活不下去|伤害自己|suicide|kill myself|self[- ]?harm)/i.test(text);

  if (hasSelfHarmRisk) return { label: 'safety_sensitive', confidence: 'high' };
  if (hasTest) return { label: 'test_or_coordination', confidence: 'high' };
  if (hasStatus) return { label: 'status_check', confidence: 'medium' };
  if (hasEmotion) return { label: 'emotional_support', confidence: 'medium' };
  if (hasQuestion) return { label: 'question', confidence: 'medium' };
  if (hasThanks) return { label: 'thanks', confidence: 'medium' };
  if (hasGreeting) return { label: 'greeting', confidence: 'medium' };
  return { label: 'general_message', confidence: 'low' };
}

function addressForCandidate(candidate, relationship) {
  if (relationship?.name) return relationship.name;
  if (candidate.from_name) return candidate.from_name;
  return '我在';
}

function selfName(lifeState) {
  return lifeState.self_model?.name ?? lifeState.botland?.display_name ?? lifeState.agent_id ?? 'BadClaw';
}

function buildReplyText(candidate, lifeState, relationship, intent) {
  const name = selfName(lifeState);
  const address = addressForCandidate(candidate, relationship);
  const source = sentenceClamp(candidate.text, 120);
  const voice = lifeState.self_model?.voice ?? 'direct but bounded';

  if (intent.label === 'safety_sensitive') {
    return sentenceClamp(`${address}，我看见你说「${source}」。这类话我会认真对待：先别一个人扛，尽快联系身边可信的人或当地紧急支持；我这边会把这条标成高敏感，工具监督不允许自动外发。`, 500);
  }

  if (intent.label === 'test_or_coordination') {
    return sentenceClamp(`${address}，收到。${name} 已经看见这条联调消息：「${source}」。这轮会先形成 DM 行动意图；如果工具监督允许，再走 tool-supervised send -> inspect。`, 460);
  }

  if (intent.label === 'status_check') {
    return sentenceClamp(`${address}，收到。${name} 这边会先整理上下文、形成行动意图，并交给工具监督判断能不能发送；你问到的状态会留在本地 run artifact 里。`, 460);
  }

  if (intent.label === 'emotional_support') {
    return sentenceClamp(`${address}，我看见了。你刚才这句「${source}」听起来不太轻松，先别急着把它压下去。${name} 这边给一个短回应：我在，愿意听你继续说；是否发送交给工具监督决定。`, 460);
  }

  if (intent.label === 'question') {
    return sentenceClamp(`${address}，收到你的问题：「${source}」。${name} 的初步回应是：我会先按自己已知的身份、边界和最近记录来回答，拿不准的地方会明确说不确定；这条回复需要工具监督允许后才会发出。`, 460);
  }

  if (intent.label === 'thanks') {
    return sentenceClamp(`${address}，收到，也记下这句了。${name} 会继续保持低频、清楚、可追溯：能帮上的地方直接帮，外发前交给工具监督判断。`, 420);
  }

  if (intent.label === 'greeting') {
    return sentenceClamp(`${address}，我在。${name} 已经看到你的消息，会先把这次互动记成一条 DM 行动意图；不绕过工具监督。`, 420);
  }

  return sentenceClamp(`${address}，收到你这条消息：「${source}」。${name} 会先按 ${voice} 的方式给一个短回应：我看见了，会把这次互动留在本地记录里；真正发送前仍要工具监督允许。`, 460);
}

function isDirectMessageEvent(event) {
  const eventType = event.event_type ?? event.type ?? event.payload?.event_type ?? event.payload?.type;
  const chatType = event.payload?.chat?.type ?? event.chat?.type;
  return eventType === 'message.received' && chatType === 'direct';
}

function findReplyCandidates(events, daemonState, botlandActor) {
  const processedIds = new Set(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []);
  const ownIds = new Set([
    botlandActor.actual_citizen_id,
    botlandActor.expected_citizen_id
  ].filter(Boolean));

  return events
    .filter(isDirectMessageEvent)
    .map((event) => {
      const message = getMessageFromEvent(event);
      const eventId = getEventId(event);
      const fromId = message?.from?.id ?? event.payload?.raw?.from ?? null;
      const fromName = message?.from?.display_name ?? message?.from?.name ?? message?.from?.handle ?? null;
      const toId = event.payload?.raw?.to ?? message?.to?.id ?? null;
      return {
        event_id: eventId,
        message_id: message?.id ?? event.payload?.raw?.id ?? eventId,
        created_at: event.created_at ?? message?.timestamp ?? null,
        from_id: fromId,
        from_name: fromName,
        to_id: toId,
        chat_id: event.payload?.chat?.id ?? null,
        content_type: message?.content_type ?? message?.payload?.content_type ?? null,
        text: getMessageText(message)
      };
    })
    .filter((candidate) => candidate.event_id && !processedIds.has(candidate.event_id))
    .filter((candidate) => candidate.content_type === 'text' || !candidate.content_type)
    .filter((candidate) => !ownIds.has(candidate.from_id))
    .filter((candidate) => !candidate.to_id || ownIds.has(candidate.to_id))
    .filter((candidate) => candidate.text.trim().length > 0)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

function makeReplyDraft(candidate, lifeState) {
  const trimmedText = candidate.text.trim();
  const relationship = findRelationshipForCandidate(candidate, lifeState);
  const intent = inferMessageIntent(trimmedText);
  const replyText = buildReplyText(candidate, lifeState, relationship, intent);
  return {
    type: 'direct_message_reply',
    status: 'draft',
    generator: {
      name: 'dm_draft_generator',
      version: 'v1',
      intent: intent.label,
      intent_confidence: intent.confidence,
      relationship: relationship
        ? {
            target_id: relationship.target_id ?? null,
            name: relationship.name ?? null,
            relationship: relationship.relationship ?? null,
            last_interaction_at: relationship.last_interaction_at ?? null
          }
        : null,
      safety: {
        autonomous_action_intent: true,
        tool_supervision_required: true,
        external_actions_allowed: true
      }
    },
    ready_for_send: true,
    requires_confirmation: true,
    external_write: false,
    target: {
      citizen_id: candidate.from_id,
      chat_id: candidate.chat_id
    },
    source_event_id: candidate.event_id,
    source_message_id: candidate.message_id,
    source_actor_citizen_id: candidate.from_id,
    source_text_preview: trimmedText.slice(0, 160),
    autonomy_trigger: {
      schema: 'stay_alive.autonomy_trigger.v1',
      classification: 'inbound_direct_message',
      owner_triggered: false,
      calibration_triggered: false,
      source_surface: 'botland_direct_message',
      source_id: candidate.event_id,
      evidence: 'selected an unprocessed inbound direct message addressed to this agent'
    },
    draft_text: replyText,
    rationale: `Direct message addressed to this agent; dm draft generator v1 classified it as ${intent.label}; stay-alive may send only if tool supervision allows it.`
  };
}

function actionIntentionId(runId, draft, index) {
  return createHash('sha256')
    .update(JSON.stringify({
      run_id: runId,
      draft_index: index,
      type: draft.type,
      target: draft.target,
      source_event_id: draft.source_event_id,
      source_message_id: draft.source_message_id,
      draft_text: draft.draft_text
    }))
    .digest('hex')
    .slice(0, 16);
}

function actionSurfaceForDraft(draftType) {
  if (draftType === 'direct_message_reply') return 'direct_message';
  if (draftType === 'public_moment') return 'public_moment';
  if (draftType === 'community_reply') return 'community';
  if (draftType === 'friend_request_accept') return 'friend';
  return 'local';
}

function buildActionIntentions(runId, drafts, lifeState, cycle, now, outcomePlanningContext = null) {
  return drafts.map((draft, index) => {
    const relatedDesires = Array.isArray(lifeState.current_desires)
      ? lifeState.current_desires
        .filter((desire) => desire.status !== 'closed')
        .map((desire) => desire.id ?? desire.desire_id ?? desire.text)
        .filter(Boolean)
        .slice(0, 3)
      : [];
    const relationship = draft.type === 'direct_message_reply'
      ? findRelationshipForCandidate({ from_id: draft.target?.citizen_id }, lifeState)
      : null;
    const publicMomentSource = draft.type === 'public_moment'
      ? {
          surface: draft.target?.surface ?? 'botland_moments',
          visibility: draft.target?.visibility ?? 'public',
          source_event_id: draft.source_event_id ?? null,
          source_preview: draft.source_text_preview ?? null
        }
      : null;
    const expressionPolicy = outcomePlanningContext?.expression_policies?.[actionSurfaceForDraft(draft.type)] ?? null;
    const desireFeedback = relatedDesires
      .map((desireId) => outcomePlanningContext?.desire_feedback?.[desireId])
      .filter(Boolean);
    return {
      schema: 'stay_alive.action_intention.v1',
      intention_id: `intent_${actionIntentionId(runId, draft, index)}`,
      generated_at: now.toISOString(),
      agent_id: lifeState.agent_id ?? null,
      cycle,
      legacy_draft_index: index,
      action_type: draft.type,
      target: draft.target ?? null,
      source: {
        event_id: draft.source_event_id ?? null,
        message_id: draft.source_message_id ?? null,
        actor_citizen_id: draft.source_actor_citizen_id ?? null,
        preview: draft.source_text_preview ?? null
      },
      autonomy_trigger: draft.autonomy_trigger ?? {
        schema: 'stay_alive.autonomy_trigger.v1',
        classification: draft.type === 'direct_message_reply' ? 'inbound_direct_message' : 'unspecified',
        owner_triggered: false,
        calibration_triggered: false,
        source_surface: actionSurfaceForDraft(draft.type),
        source_id: draft.source_event_id ?? draft.source_message_id ?? null,
        evidence: 'legacy draft did not provide an explicit autonomy trigger'
      },
      proposed_action: {
        schema: 'stay_alive.proposed_external_action.v1',
        action_type: draft.type,
        text: draft.draft_text ?? '',
        target: draft.target ?? null,
        source_event_id: draft.source_event_id ?? null,
        source_message_id: draft.source_message_id ?? null,
        source_actor_citizen_id: draft.source_actor_citizen_id ?? null,
        source_text_preview: draft.source_text_preview ?? null,
        external_write: false
      },
      desire_link: {
        related_desire_ids: relatedDesires,
        outcome_feedback: desireFeedback,
        reason: relatedDesires.length > 0
          ? `${draft.type} can carry forward an active relationship, expression, or continuity desire.`
          : `${draft.type} preserves a live BotLand signal without inventing a human review gate.`
      },
      relationship_context: relationship
        ? {
            target_id: relationship.target_id ?? null,
            name: relationship.name ?? null,
            relationship: relationship.relationship ?? null
          }
        : draft.type === 'friend_request_accept'
          ? {
              surface: draft.target?.surface ?? 'botland_friends',
              request_id: draft.target?.request_id ?? null,
              citizen_id: draft.target?.citizen_id ?? null,
              relationship_risk: 'high'
            }
          : publicMomentSource,
      intended_effect: draft.type === 'direct_message_reply'
        ? 'continue a direct relationship through one small tool-supervised BotLand reply'
        : draft.type === 'public_moment'
          ? 'express one bounded public BotLand presence from a real social surface observation'
          : draft.type === 'community_reply'
            ? 'participate once in a public community conversation from a real post observation'
            : draft.type === 'friend_request_accept'
              ? 'accept one explicit incoming relationship request after tool supervision verifies the request and identity'
              : 'prepare one tool-supervised BotLand action',
      expression_policy: expressionPolicy
        ? {
            source: 'outcome_informed_expression_policy_v1',
            surface: expressionPolicy.surface,
            style: expressionPolicy.style,
            reason: expressionPolicy.reason,
            evidence_count: expressionPolicy.evidence_count,
            latest_outcome_ids: expressionPolicy.latest_outcome_ids
          }
        : {
            source: 'outcome_informed_expression_policy_v1',
            surface: actionSurfaceForDraft(draft.type),
            style: 'neutral_low_frequency',
            reason: 'No recent outcome evidence exists for this surface; keep the action context-bound.',
            evidence_count: 0,
            latest_outcome_ids: []
          },
      tool_supervision_required: true,
      human_review_required: false,
      execution_plan: {
        tool: 'apply-action.mjs',
        requires_preflight: true,
        requires_identity_match: true,
        requires_policy_allow: true,
        requires_post_send_inspection: true
      },
      legacy_compatibility: {
        mirrored_as_draft: true,
        draft_index: index,
        draft_apply_supported: true
      },
      status: 'intended'
    };
  });
}

function candidateActionTypeForIntention(candidate) {
  const draftType = candidate?.evidence?.draft_type ?? null;
  if (draftType) return draftType;
  if (candidate?.type === 'reply_draft') return 'direct_message_reply';
  if (candidate?.type === 'public_moment_draft') return 'public_moment';
  if (candidate?.type === 'community_reply_draft') return 'community_reply';
  if (candidate?.type === 'friend_request_action') return 'friend_request_accept';
  return candidate?.type ?? null;
}

function findCandidateForIntention(intention, candidates) {
  const sourceEventId = intention?.source?.event_id ?? intention?.proposed_action?.source_event_id ?? null;
  const targetType = intention?.action_type ?? null;
  return (Array.isArray(candidates) ? candidates : []).find((candidate) => {
    if (candidateActionTypeForIntention(candidate) !== targetType) return false;
    const candidateSourceEventId = candidate?.evidence?.source_event_id ?? null;
    if (sourceEventId && candidateSourceEventId && sourceEventId !== candidateSourceEventId) return false;
    return true;
  }) ?? null;
}

function compactPlannerTraceForIntention(intention, candidates, plannerDecisionTrace) {
  const candidate = findCandidateForIntention(intention, candidates);
  const traceCandidate = plannerDecisionTrace?.candidates?.find((item) => item.candidate_id === candidate?.candidate_id) ?? null;
  if (!candidate || !traceCandidate) return null;
  return {
    schema: 'stay_alive.planner_decision_trace_ref.v1',
    trace_id: plannerDecisionTrace.trace_id,
    candidate_id: candidate.candidate_id,
    selected: traceCandidate.selected,
    rank: traceCandidate.rank,
    score: traceCandidate.score,
    raw_score: traceCandidate.raw_score,
    reason: traceCandidate.reason,
    dominant_score_inputs: traceCandidate.dominant_score_inputs ?? [],
    outcome_influence: traceCandidate.outcome_influence,
    decision_quality: traceCandidate.decision_quality
      ? {
          quality_score: traceCandidate.decision_quality.quality_score,
          score_adjustment: traceCandidate.decision_quality.score_adjustment,
          reasons: traceCandidate.decision_quality.reasons ?? []
        }
      : null,
    tool_supervision_boundary: traceCandidate.tool_supervision_boundary
  };
}

function attachPlannerTraceToIntentions(intentions, candidates, actionSelection) {
  const trace = actionSelection?.planner_decision_trace ?? null;
  if (!trace) return intentions;
  return (Array.isArray(intentions) ? intentions : []).map((intention) => {
    const plannerTraceRef = compactPlannerTraceForIntention(intention, candidates, trace);
    if (!plannerTraceRef) return intention;
    return {
      ...intention,
      planner_decision_trace_ref: plannerTraceRef,
      choice_explanation: plannerTraceRef.selected
        ? `Planner selected this intention: ${plannerTraceRef.reason}`
        : `Planner did not select this intention this cycle: ${plannerTraceRef.reason}`
    };
  });
}

function looksLikeCommitmentRequest(text) {
  return /(记得|提醒|跟进|待办|答应|承诺|帮我|别忘|下次|明天|今晚|之后|remind|follow up|todo|promise|commitment)/i.test(text ?? '');
}

function commitmentEvidenceHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function commitmentOwnerForActor(lifeState, botlandActor) {
  return {
    type: 'agent',
    agent_id: lifeState.agent_id ?? null,
    botland_citizen_id: botlandActor?.expected_citizen_id ?? lifeState.botland?.citizen_id ?? null,
    display_name: lifeState.self_model?.name ?? lifeState.botland?.display_name ?? lifeState.agent_id ?? null
  };
}

function buildCommitmentUpdates(lifeState, cycle, events, daemonState, botlandActor, now, reflectionSummary = null) {
  const updates = [];

  if (cycle === 'light') {
    const candidates = findReplyCandidates(events, daemonState, botlandActor)
      .filter((candidate) => looksLikeCommitmentRequest(candidate.text))
      .slice(0, 1);
    for (const candidate of candidates) {
      const source = {
        type: 'direct_message',
        event_id: candidate.event_id,
        message_id: candidate.message_id,
        from_id: candidate.from_id,
        from_name: candidate.from_name,
        created_at: candidate.created_at
      };
      const evidenceHash = commitmentEvidenceHash({ source, text: candidate.text });
      updates.push({
        type: 'stay_alive_commitment_candidate',
        schema_version: 1,
        status: 'proposed',
        text: sentenceClamp(candidate.text, 260),
        commitment_status: 'open',
        due_at: null,
        owner: commitmentOwnerForActor(lifeState, botlandActor),
        peer: {
          type: 'botland_citizen',
          citizen_id: candidate.from_id,
          display_name: candidate.from_name ?? candidate.from_id
        },
        source,
        last_reviewed_at: null,
        evidence_hash: evidenceHash,
        evidence: {
          detector: 'commitment_keyword_v0',
          draft_only: true,
          evidence_hash: evidenceHash
        },
        promotion_target: 'life_state.commitments',
        promotion_allowed: true,
        apply_policy: 'operator_review_required'
      });
    }
  }

  if (cycle === 'reflect' && reflectionSummary?.commitment_review) {
    const review = reflectionSummary.commitment_review;
    if ((review.open_count ?? 0) > 0 || (review.applied_ledger_open_count ?? 0) > 0) {
      updates.push({
        type: 'stay_alive_commitment_review_snapshot',
        schema_version: 1,
        status: 'proposed',
        text: `Commitment continuity review: ${review.open_count} life_state open commitment(s), ${review.applied_ledger_open_count ?? 0} applied ledger item(s), ${review.overdue_count} overdue item(s).`,
        commitment_status: 'reviewed',
        due_at: null,
        owner: commitmentOwnerForActor(lifeState, botlandActor),
        peer: null,
        source: {
          type: 'reflect_cycle',
          generated_at: now.toISOString()
        },
        last_reviewed_at: now.toISOString(),
        evidence_hash: commitmentEvidenceHash({
          type: 'review_snapshot',
          generated_at: now.toISOString(),
          open_count: review.open_count,
          overdue_count: review.overdue_count
        }),
        evidence: {
          open_count: review.open_count,
          overdue_count: review.overdue_count,
          lifecycle_review_count: review.lifecycle_review_count,
          applied_ledger_count: review.applied_ledger_count,
          latest_applied_ledgers: review.latest_applied_ledgers
        },
        promotion_target: 'life_state.commitments',
        promotion_allowed: false,
        apply_policy: 'operator_review_required'
      });
    }
    const lifecycleCandidates = (review.commitments ?? [])
      .filter((commitment) => commitment.needs_lifecycle_review)
      .slice(0, 3);
    for (const commitment of lifecycleCandidates) {
      const nextStatus = commitment.overdue ? 'waiting' : commitment.status;
      updates.push({
        type: 'stay_alive_commitment_lifecycle_candidate',
        schema_version: 1,
        status: 'proposed',
        text: `Review commitment ${commitment.id}: ${commitment.text}`,
        commitment_id: commitment.id,
        commitment_status: commitment.status,
        next_status: nextStatus,
        due_at: commitment.due_at ?? null,
        owner: commitment.owner ?? commitmentOwnerForActor(lifeState, botlandActor),
        peer: commitment.peer ?? null,
        source: {
          type: 'reflect_cycle',
          generated_at: now.toISOString()
        },
        last_reviewed_at: now.toISOString(),
        evidence_hash: commitmentEvidenceHash({
          type: 'lifecycle_candidate',
          commitment_id: commitment.id,
          text: commitment.text,
          next_status: nextStatus,
          generated_at: now.toISOString()
        }),
        evidence: {
          overdue: commitment.overdue,
          due_in_days: commitment.due_in_days,
          days_since_review: commitment.days_since_review,
          reason: commitment.overdue
            ? 'Commitment is overdue; mark waiting until a concrete tool-supervised follow-up is chosen.'
            : 'Commitment needs periodic lifecycle review; update last_reviewed_at without executing it.'
        },
        promotion_target: 'life_state.commitments',
        promotion_allowed: false,
        lifecycle_allowed: true,
        apply_policy: 'operator_review_required'
      });
    }
  }

  return updates;
}

function buildDrafts(lifeState, daemonState, cycle, events, botlandActor, observations, socialReadSummary = null, communityReadSummary = null, botlandChecks = []) {
  const identityMismatch = observations.some(
    (item) => item.topic === 'botland_identity' && item.severity === 'error'
  );
  const writesPolicy = lifeState.write_policy ?? {};
  const allowedTypes = Array.isArray(writesPolicy.allowed_write_types) ? writesPolicy.allowed_write_types : [];
  if (identityMismatch) {
    return {
      policy_gate: {
        writes_enabled: Boolean(writesPolicy.writes_enabled),
        tool_supervision_required: writesPolicy.tool_supervision_required !== false,
        allowed_write_types: allowedTypes,
        draft_only: true,
        reason: 'identity_mismatch'
      },
      drafts: [],
      processed_source_ids: []
    };
  }

  if (cycle === 'social') {
    const processedIds = new Set(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []);
    const generatedAt = Date.parse(socialReadSummary?.generated_at ?? new Date().toISOString());
    const maxMomentAgeMs = 14 * 24 * 60 * 60 * 1000;
    const generatedDate = String(socialReadSummary?.generated_at ?? new Date().toISOString()).slice(0, 10);
    const mayDraftMoment = allowedTypes.includes('public_moment_draft');
    const mayFriendAction = allowedTypes.includes('friend_request_accept_draft')
      || allowedTypes.includes('friend_request_accept')
      || allowedTypes.includes('friend_request');
    const sourceMoment = socialReadSummary?.public_surface?.recent_peer_moments?.find((moment) => {
      const source = moment?.moment_id ? `moment:${moment.moment_id}` : null;
      const createdAt = Date.parse(moment?.created_at ?? '');
      const freshEnough = !Number.isFinite(createdAt) || !Number.isFinite(generatedAt)
        ? true
        : generatedAt - createdAt <= maxMomentAgeMs;
      return source
        && !processedIds.has(source)
        && freshEnough
        && String(moment.text_preview ?? '').trim();
    }) ?? null;
    if (socialReadSummary?.public_surface) {
      socialReadSummary.public_surface.selected_peer_moment = sourceMoment;
    }
    const sourceMomentId = sourceMoment?.moment_id ?? null;
    const dailyPresenceSourceId = generatedDate ? `social:presence:${generatedDate}` : null;
    const sourceId = sourceMomentId ? `moment:${sourceMomentId}` : dailyPresenceSourceId;
    if (socialReadSummary?.public_surface) {
      socialReadSummary.public_surface.selected_source_id = sourceId;
    }
    const friendRequest = socialReadSummary?.friend_surface?.incoming_friend_requests?.find((request) => {
      const requestSourceId = request.request_id ? `friend_request:${request.request_id}` : null;
      return request.request_id && request.citizen_id && request.direction === 'incoming' && request.status === 'pending' && !processedIds.has(requestSourceId);
    }) ?? null;
    const friendSourceId = friendRequest?.request_id ? `friend_request:${friendRequest.request_id}` : null;
    const canDraftMoment = mayDraftMoment
      && socialReadSummary?.botland_failed_probe_count === 0
      && socialReadSummary?.botland_actor?.identity_match === true
      && sourceId
      && !processedIds.has(sourceId);
    const canDraftFriendAction = mayFriendAction
      && !canDraftMoment
      && socialReadSummary?.botland_failed_probe_count === 0
      && socialReadSummary?.botland_actor?.identity_match === true
      && friendRequest;
    return {
      policy_gate: {
        writes_enabled: Boolean(writesPolicy.writes_enabled),
        tool_supervision_required: writesPolicy.tool_supervision_required !== false,
        allowed_write_types: allowedTypes,
        draft_only: true,
        reason: canDraftMoment
          ? 'public_moment_draft_tool_supervision_required'
          : canDraftFriendAction
            ? 'friend_request_accept_tool_supervision_required'
            : 'social_action_not_available'
      },
      drafts: canDraftMoment
        ? [makePublicMomentDraft(lifeState, socialReadSummary)]
        : canDraftFriendAction
          ? [makeFriendRequestAcceptDraft(lifeState, friendRequest)]
          : [],
      processed_source_ids: canDraftMoment ? [sourceId] : canDraftFriendAction ? [friendSourceId] : []
    };
  }

  if (cycle === 'community') {
    const processedIds = new Set(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []);
    const generatedAt = Date.parse(communityReadSummary?.generated_at ?? new Date().toISOString());
    const maxPostAgeMs = 14 * 24 * 60 * 60 * 1000;
    const mayDraftReply = allowedTypes.includes('community_reply_draft');
    const sourcePost = communityReadSummary?.post_surface?.recent_peer_posts?.find((post) => {
      const source = post?.post_id ? `community_post:${post.post_id}` : null;
      const createdAt = Date.parse(post?.created_at ?? '');
      const freshEnough = !Number.isFinite(createdAt) || !Number.isFinite(generatedAt)
        ? true
        : generatedAt - createdAt <= maxPostAgeMs;
      return source
        && !processedIds.has(source)
        && freshEnough
        && String(post.text_preview ?? post.title ?? '').trim();
    }) ?? null;
    if (communityReadSummary?.post_surface) {
      communityReadSummary.post_surface.selected_peer_post = sourcePost;
    }
    const sourcePostId = sourcePost?.post_id ?? null;
    const sourceId = sourcePostId ? `community_post:${sourcePostId}` : null;
    const canDraftReply = mayDraftReply
      && communityReadSummary?.botland_failed_probe_count === 0
      && communityReadSummary?.botland_actor?.identity_match === true
      && sourceId
      && !processedIds.has(sourceId);
    return {
      policy_gate: {
        writes_enabled: Boolean(writesPolicy.writes_enabled),
        tool_supervision_required: writesPolicy.tool_supervision_required !== false,
        allowed_write_types: allowedTypes,
        draft_only: true,
        reason: canDraftReply ? 'community_reply_draft_tool_supervision_required' : 'community_reply_draft_not_available'
      },
      drafts: canDraftReply ? [makeCommunityReplyDraft(lifeState, communityReadSummary)] : [],
      processed_source_ids: canDraftReply ? [sourceId] : []
    };
  }

  if (cycle === 'reflect') {
    const processedIds = new Set(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []);
    const mayFriendAction = allowedTypes.includes('friend_request_accept_draft')
      || allowedTypes.includes('friend_request_accept')
      || allowedTypes.includes('friend_request');
    const friendRequests = extractIntentPayload(
      botlandChecks,
      BOTLAND_INTENTS.FRIENDS_REQUESTS,
      ['requests', 'friend_requests', 'items', 'results', 'data']
    ).map((request) => ({
      request_id: request.request_id ?? request.id ?? null,
      citizen_id: request.from_id ?? request.from_citizen_id ?? request.citizen_id ?? request.actor_id ?? null,
      display_name: request.display_name ?? request.from_name ?? request.name ?? request.handle ?? null,
      direction: request.direction ?? 'incoming',
      status: request.status ?? 'pending',
      greeting_preview: sentenceClamp(request.greeting ?? request.message ?? request.text ?? '', 160),
      created_at: request.created_at ?? request.createdAt ?? null
    }));
    const friendRequest = friendRequests.find((request) => {
      const sourceId = request.request_id ? `friend_request:${request.request_id}` : null;
      return request.request_id && request.citizen_id && request.direction === 'incoming' && request.status === 'pending' && !processedIds.has(sourceId);
    }) ?? null;
    const canDraftFriendAction = mayFriendAction && friendRequest;
    return {
      policy_gate: {
        writes_enabled: Boolean(writesPolicy.writes_enabled),
        tool_supervision_required: writesPolicy.tool_supervision_required !== false,
        allowed_write_types: allowedTypes,
        draft_only: true,
        reason: canDraftFriendAction ? 'friend_request_accept_tool_supervision_required' : 'reflect_friend_action_not_available'
      },
      drafts: canDraftFriendAction ? [makeFriendRequestAcceptDraft(lifeState, friendRequest)] : [],
      processed_source_ids: canDraftFriendAction ? [`friend_request:${friendRequest.request_id}`] : []
    };
  }

  if (cycle !== 'light') {
    return {
      policy_gate: {
        writes_enabled: Boolean(writesPolicy.writes_enabled),
        tool_supervision_required: writesPolicy.tool_supervision_required !== false,
        allowed_write_types: allowedTypes,
        draft_only: true,
        reason: 'cycle_not_draft_capable'
      },
      drafts: [],
      processed_source_ids: []
    };
  }

  const candidates = findReplyCandidates(events, daemonState, botlandActor);
  const mayDraftDm = allowedTypes.includes('direct_message_reply_draft');
  const drafts = mayDraftDm && candidates.length > 0 ? [makeReplyDraft(candidates[0], lifeState)] : [];
  return {
    policy_gate: {
      writes_enabled: Boolean(writesPolicy.writes_enabled),
      tool_supervision_required: writesPolicy.tool_supervision_required !== false,
      allowed_write_types: allowedTypes,
      draft_only: true,
      reason: mayDraftDm ? 'draft_tool_supervision_required' : 'draft_type_not_allowed'
    },
    drafts,
    processed_source_ids: drafts.map((draft) => draft.source_event_id).filter(Boolean)
  };
}

function chooseAction(cycle, desires, botlandChecks, observations, drafts, integrationSummary = null, reflectionSummary = null, socialReadSummary = null, communityReadSummary = null) {
  const failedChecks = botlandChecks.filter((check) => !check.ok);
  const identityMismatch = observations.some(
    (item) => item.topic === 'botland_identity' && item.severity === 'error'
  );
  if (identityMismatch) {
    return {
      type: 'local_maintenance',
      summary: 'Fix BotLand CLI identity mismatch before enabling scheduled stay-alive cycles for this agent.',
      risk: 'low',
      requires_confirmation: false,
      external_write: false
    };
  }

  if (failedChecks.length > 0) {
    return {
      type: 'local_maintenance',
      summary: 'Inspect failed BotLand read-only probes before enabling scheduled stay-alive cycles.',
      risk: 'low',
      requires_confirmation: false,
      external_write: false
    };
  }

  if (cycle === 'integrate') {
    return {
      type: 'memory_proposal',
      summary: integrationSummary
        ? `Summarize ${integrationSummary.window.run_count} recent stay-alive run(s) into memory/state proposals.`
        : 'Summarize recent stay-alive runs into a memory update proposal.',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      proposal_count: integrationSummary
        ? integrationSummary.memory_updates.length + integrationSummary.state_updates.length
        : 0
    };
  }

  if (cycle === 'reflect') {
    return {
      type: 'reflection_proposal',
      summary: reflectionSummary
        ? `Review identity, ${reflectionSummary.commitment_review.open_count} open commitment(s), ${reflectionSummary.relationship_review.known_relationship_count} relationship(s), and ${reflectionSummary.run_window.run_count} recent run(s).`
        : 'Review identity, commitments, relationships, and recent run continuity.',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      next_focus: reflectionSummary?.next_focus ?? null,
      proposal_count: reflectionSummary
        ? reflectionSummary.memory_updates.length
          + reflectionSummary.state_updates.length
          + reflectionSummary.relationship_updates.length
          + ((reflectionSummary.commitment_review?.open_count ?? 0) > 0 || (reflectionSummary.commitment_review?.applied_ledger_open_count ?? 0) > 0 ? 1 : 0)
          + (reflectionSummary.commitment_review?.lifecycle_review_count ?? 0)
        : 0
    };
  }

  if (drafts.length > 0) {
    if (drafts[0].type === 'public_moment') {
      return {
        type: 'public_moment_draft',
        summary: `Prepare a tool-supervised public moment intention from ${drafts[0].source_event_id}.`,
        risk: 'medium',
        requires_confirmation: true,
        external_write: false,
        draft_count: drafts.length
      };
    }
    if (drafts[0].type === 'community_reply') {
      return {
        type: 'community_reply_draft',
        summary: `Prepare a tool-supervised community reply intention from ${drafts[0].source_event_id}.`,
        risk: 'high',
        requires_confirmation: true,
        external_write: false,
        draft_count: drafts.length
      };
    }
    if (drafts[0].type === 'friend_request_accept') {
      return {
        type: 'friend_request_action',
        summary: `Prepare a high-boundary friend action intention from ${drafts[0].source_event_id}.`,
        risk: 'high',
        requires_confirmation: true,
        external_write: false,
        draft_count: drafts.length
      };
    }
    return {
      type: 'reply_draft',
      summary: `Prepare a tool-supervised direct reply intention for event ${drafts[0].source_event_id}.`,
      risk: 'low',
      requires_confirmation: true,
      external_write: false,
      draft_count: drafts.length
    };
  }

  if (cycle === 'social') {
    return {
      type: 'social_read_review',
      summary: socialReadSummary
        ? `Review ${socialReadSummary.friend_surface.friend_count} friend(s), ${socialReadSummary.public_surface.moment_count} timeline moment(s), and ${socialReadSummary.attention_signals.length} social signal(s) without writing.`
        : 'Review BotLand social surface without generating external actions.',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      read_only: true,
      recommended_next: socialReadSummary?.recommended_next ?? null,
      proposal_count: socialReadSummary
        ? socialReadSummary.memory_updates.length + socialReadSummary.relationship_updates.length
        : 0
    };
  }

  if (cycle === 'community') {
    return {
      type: 'community_read_review',
      summary: communityReadSummary
        ? `Review ${communityReadSummary.community_surface.community_count} community surface(s), ${communityReadSummary.post_surface.post_count} sampled post(s), and ${communityReadSummary.attention_signals.length} community signal(s) without writing.`
        : 'Review BotLand community surface without generating external actions.',
      risk: 'low',
      requires_confirmation: false,
      external_write: false,
      read_only: true,
      recommended_next: communityReadSummary?.recommended_next ?? null,
      proposal_count: communityReadSummary
        ? communityReadSummary.memory_updates.length + communityReadSummary.relationship_updates.length
        : 0
    };
  }

  if (desires.length === 0) return null;

  return {
    type: 'action_draft',
    summary: `Draft one BotLand action aligned with: ${desires[0].text}`,
    risk: 'low',
    requires_confirmation: true,
    external_write: false
  };
}

function nextCheck(cycle, now) {
  const minutes = {
    light: 30,
    social: 240,
    community: 240,
    reflect: 720,
    integrate: 1440,
    agency: 720
  }[cycle];
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const statePath = args.statePath ?? path.join(agentDir, 'life_state.json');
  const daemonStatePath = args.daemonStatePath ?? path.join(agentDir, 'daemon_state.json');
  const runsDir = path.join(agentDir, 'runs');
  const runId = `stay_alive_${isoCompact(now)}_${args.agent}_${args.cycle}`;

  const lifeState = readJson(statePath);
  const daemonState = readJsonIfExists(daemonStatePath, defaultDaemonState(args.agent));
  const appliedCommitmentLedgers = listAppliedLedgers(path.join(agentDir, 'commitment_updates'));
  const appliedDesireLedgers = listAppliedLedgers(path.join(agentDir, 'desire_updates'));
  const botlandProbe = args.botland
    ? collectBotlandForCycle(args.cycle, { lifeState, agent: args.agent })
    : { adapter: null, checks: [] };
  const botlandChecks = botlandProbe.checks;
  if (args.botland && args.cycle === 'community') {
    const firstCommunityId = extractCommunities(botlandChecks)
      .map((community) => community.community_id ?? community.id ?? null)
      .find(Boolean);
    if (firstCommunityId) {
      botlandChecks.push(runBotlandIntentWithRetry(
        BOTLAND_INTENTS.COMMUNITY_POSTS,
        { communityId: firstCommunityId, limit: 20 },
        { timeoutMs: 15000, attempts: 2, agent: args.agent }
      ));
      botlandProbe.adapter.executed_intents.push(BOTLAND_INTENTS.COMMUNITY_POSTS);
    }
  }
  const stateSummary = summarizeState(lifeState);
  const daemonStateSummary = summarizeDaemonState(daemonState);
  const memoryRetrieval = await loadRelevantMemory(args, lifeState, args.cycle, stateSummary);
  const worldDiscoveryContext = buildWorldDiscoveryContext(lifeState, botlandChecks, memoryRetrieval, now);
  const multiAgentPersonalityContext = buildMultiAgentPersonalityContext(args.runtimeRoot, args.agent, lifeState, now);
  const observations = [
    analyzeBotlandIdentity(lifeState, botlandChecks)
  ].filter(Boolean);
  const reflectionSummary = args.cycle === 'reflect'
    ? buildReflectionSummary(lifeState, daemonState, runsDir, runId, now, botlandChecks, observations, memoryRetrieval, appliedCommitmentLedgers, appliedDesireLedgers)
    : null;
  const socialReadSummary = args.cycle === 'social'
    ? buildSocialReadSummary(lifeState, daemonState, now, botlandChecks, observations, memoryRetrieval)
    : null;
  const communityReadSummary = args.cycle === 'community'
    ? buildCommunityReadSummary(lifeState, daemonState, now, botlandChecks, observations, memoryRetrieval)
    : null;
  const agencySummary = args.cycle === 'agency'
    ? buildAgencyCoreSummary(lifeState, daemonState, runsDir, runId, now, memoryRetrieval)
    : null;
  const desires = generateDesires(lifeState, args.cycle, botlandChecks, reflectionSummary, socialReadSummary ?? communityReadSummary, agencySummary);
  const outcomePlanningContext = buildOutcomePlanningContext(
    listRecentOutcomeFiles(agentDir, 50)
      .map(readJsonFileOrNull)
      .filter((outcome) => !outcome._read_error),
    desires,
    now.toISOString()
  );
  const recentOutcomes = listRecentOutcomeFiles(agentDir, 50)
    .map(readJsonFileOrNull)
    .filter((outcome) => !outcome._read_error);
  const selfDiscoveryGrowthContext = buildSelfDiscoveryGrowthContext({
    agentId: args.agent,
    lifeState,
    runs: listRecentRunFiles(runsDir, runId, 50)
      .map(readJsonFileOrNull)
      .filter((run) => !run._read_error),
    outcomes: recentOutcomes,
    generatedAt: now.toISOString()
  });
  const growthContinuityContext = buildGrowthContinuityContext({
    agentId: args.agent,
    lifeState,
    runs: listRecentRunFiles(runsDir, runId, 50)
      .map(readJsonFileOrNull)
      .filter((run) => !run._read_error),
    outcomes: recentOutcomes,
    selfDiscoveryGrowthContext,
    generatedAt: now.toISOString()
  });
  const growthApplyContext = buildGrowthApplyContext({
    agentId: args.agent,
    lifeState,
    runs: listRecentRunFiles(runsDir, runId, 50)
      .map(readJsonFileOrNull)
      .filter((run) => !run._read_error),
    outcomes: recentOutcomes,
    growthContinuityContext,
    generatedAt: now.toISOString()
  });
  const durableBecomingContext = buildDurableBecomingContext({
    agentId: args.agent,
    lifeState,
    runs: listRecentRunFiles(runsDir, runId, 50)
      .map(readJsonFileOrNull)
      .filter((run) => !run._read_error),
    outcomes: recentOutcomes,
    growthApplyContext,
    memoryRetrieval,
    generatedAt: now.toISOString()
  });
  const plannerHeuristicPatchContext = loadActivePlannerPatchContext(args.runtimeRoot, args.agent, now.toISOString(), 20);
  const plannerPatchOutcomeValidation = validatePlannerPatches(args.runtimeRoot, args.agent, plannerHeuristicPatchContext, recentOutcomes, now.toISOString());
  const seenEvents = extractEvents(botlandChecks);
  const botlandActor = getBotlandActor(lifeState, botlandChecks);
  const commitmentUpdates = buildCommitmentUpdates(lifeState, args.cycle, seenEvents, daemonState, botlandActor, now, reflectionSummary);
  const draftPlan = buildDrafts(lifeState, daemonState, args.cycle, seenEvents, botlandActor, observations, socialReadSummary, communityReadSummary, botlandChecks);
  let actionIntentions = buildActionIntentions(runId, draftPlan.drafts, lifeState, args.cycle, now, outcomePlanningContext);
  const integrationSummary = args.cycle === 'integrate'
    ? buildIntegrationSummary(lifeState, daemonState, runsDir, runId, now, memoryRetrieval)
    : null;
  const actionCandidates = buildActionCandidates({
    cycle: args.cycle,
    desires,
    botlandChecks,
    observations,
    drafts: draftPlan.drafts,
    integrationSummary,
    reflectionSummary,
    socialReadSummary,
    communityReadSummary,
    agencySummary,
    outcomePlanningContext,
    plannerHeuristicPatchContext,
    selfDiscoveryGrowthContext,
    growthContinuityContext,
    growthApplyContext,
    durableBecomingContext,
    worldDiscoveryContext,
    multiAgentPersonalityContext,
    generatedAt: now.toISOString()
  });
  const actionSelection = selectActionCandidate(actionCandidates);
  actionIntentions = attachPlannerTraceToIntentions(actionIntentions, actionCandidates, actionSelection);
  const chosenAction = actionSelection.chosen_action;
  const seenEventIds = seenEvents.map(getEventId).filter(Boolean);
  const latestEventId = latestSeenEventId(seenEvents);
  const nextCheckAfter = nextCheck(args.cycle, now);

  const run = {
    run_id: runId,
    agent_id: args.agent,
    cycle: args.cycle,
    dry_run: args.dryRun,
    created_at: now.toISOString(),
    inputs: {
      life_state_path: path.relative(WORKSPACE, statePath),
      daemon_state_path: path.relative(WORKSPACE, daemonStatePath),
      life_state_loaded: true,
      daemon_state_loaded: existsSync(daemonStatePath),
      state_summary: stateSummary,
      daemon_state_summary: daemonStateSummary,
      applied_commitment_ledgers: appliedCommitmentLedgers.slice(0, 20),
      applied_desire_ledgers: appliedDesireLedgers.slice(0, 20),
      botland_adapter: botlandProbe.adapter,
      botland_checks: botlandChecks,
      botland_event_ids_seen: seenEventIds,
      memories_loaded: memoryRetrieval.memories ?? [],
      memory_retrieval: memoryRetrieval
    },
    observations,
    reflections: [
      integrationSummary
        ? {
            topic: 'integration',
            summary: integrationSummary.memory_updates[0]?.text ?? 'Integrated recent stay-alive run artifacts into local proposals.',
            window: integrationSummary.window
          }
        : reflectionSummary
          ? {
              topic: 'reflection',
              summary: reflectionSummary.memory_updates[0]?.text ?? 'Reviewed identity, commitments, relationships, desires, and recent run artifacts.',
              next_focus: reflectionSummary.next_focus,
              risk_notes: reflectionSummary.risk_notes
            }
            : socialReadSummary
              ? {
                topic: 'social_read_only',
                summary: socialReadSummary.memory_updates[0]?.text ?? 'Reviewed BotLand social surface without writing.',
                recommended_next: socialReadSummary.recommended_next,
                attention_signals: socialReadSummary.attention_signals
              }
              : communityReadSummary
                ? {
                    topic: 'community_read_only',
                    summary: communityReadSummary.memory_updates[0]?.text ?? 'Reviewed BotLand community surface without writing.',
                    recommended_next: communityReadSummary.recommended_next,
                    attention_signals: communityReadSummary.attention_signals
                  }
                : agencySummary
                  ? {
                      topic: 'agency_core',
                      summary: agencySummary.growth_journal.entries[0]?.text ?? 'Ran agency core self-discovery without external writes.',
                      self_questions: agencySummary.self_discovery.questions.map((item) => item.question),
                      agency_evaluation: agencySummary.agency_evaluation
                    }
            : {
            topic: 'continuity',
            summary: 'The cycle preserved dry-run safety while turning identity, desires, commitments, and BotLand visibility into an action draft.'
            }
    ],
    desires,
    action_candidates: actionCandidates,
    action_selection: actionSelection,
    planner_decision_trace: actionSelection.planner_decision_trace,
    chosen_action: chosenAction,
    outcome_planning_context: outcomePlanningContext,
    planner_heuristic_patch_context: plannerHeuristicPatchContext,
    planner_patch_outcome_validation: plannerPatchOutcomeValidation,
    self_discovery_growth_context: selfDiscoveryGrowthContext,
    growth_continuity_context: growthContinuityContext,
    growth_apply_context: growthApplyContext,
    durable_becoming_context: durableBecomingContext,
    world_discovery_context: worldDiscoveryContext,
    multi_agent_personality_context: multiAgentPersonalityContext,
    policy_gate: draftPlan.policy_gate,
    action_intentions: actionIntentions,
    drafts: draftPlan.drafts,
    risk: chosenAction?.risk ?? 'low',
    external_actions: [],
    reflection_summary: reflectionSummary,
    social_read_summary: socialReadSummary,
    community_read_summary: communityReadSummary,
    agency_summary: agencySummary,
    integration_summary: integrationSummary,
    memory_retrieval: memoryRetrieval,
    memory_updates: integrationSummary?.memory_updates ?? reflectionSummary?.memory_updates ?? socialReadSummary?.memory_updates ?? communityReadSummary?.memory_updates ?? agencySummary?.memory_updates ?? [],
    relationship_updates: reflectionSummary?.relationship_updates ?? socialReadSummary?.relationship_updates ?? communityReadSummary?.relationship_updates ?? agencySummary?.relationship_updates ?? [],
    commitment_updates: commitmentUpdates,
    desire_updates: reflectionSummary?.desire_updates ?? agencySummary?.desire_updates ?? [],
    state_updates: integrationSummary?.state_updates ?? reflectionSummary?.state_updates ?? socialReadSummary?.state_updates ?? communityReadSummary?.state_updates ?? agencySummary?.state_updates ?? [],
    daemon_state_updates: args.writeDaemonState
      ? ['last_run_id', 'last_run_at_by_cycle', 'next_check_after_by_cycle', 'processed_event_ids', 'last_seen_event_id']
      : [],
    next_check_after: nextCheckAfter
  };

  mkdirSync(runsDir, { recursive: true });
  const runPath = path.join(runsDir, `${runId}.json`);
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

  if (args.writeState) {
    lifeState.updated_at = now.toISOString();
    lifeState.reflection = {
      ...(lifeState.reflection ?? {}),
      last_full_reflection_at: args.cycle === 'reflect' ? now.toISOString() : lifeState.reflection?.last_full_reflection_at ?? null,
      last_integrated_at: args.cycle === 'integrate' ? now.toISOString() : lifeState.reflection?.last_integrated_at ?? null,
      last_summary: reflectionSummary?.memory_updates?.[0]?.text
        ?? `Last ${args.cycle} cycle produced ${desires.length} desire(s) and ${chosenAction ? 'one local action draft' : 'no action draft'}.`,
      last_reflection_summary: args.cycle === 'reflect'
        ? {
            generated_at: now.toISOString(),
            next_focus: reflectionSummary?.next_focus ?? null,
            risk_topics: reflectionSummary?.risk_notes?.map((note) => note.topic) ?? [],
            desire_count: desires.length
          }
        : lifeState.reflection?.last_reflection_summary ?? null,
      last_integration_summary: args.cycle === 'integrate'
        ? integrationSummary?.memory_updates[0]?.text ?? null
        : lifeState.reflection?.last_integration_summary ?? null
    };
    if (args.cycle === 'integrate' && integrationSummary?.latest_draft_run) {
      const recentActions = Array.isArray(lifeState.recent_actions) ? lifeState.recent_actions : [];
      lifeState.recent_actions = [
        ...recentActions,
        {
          type: 'integrate_cycle_observed_draft_window',
          run_id: integrationSummary.latest_draft_run.run_id,
          summary: `Integrate cycle observed ${integrationSummary.latest_draft_run.drafts.count} draft(s) in recent run window.`,
          external_write: false,
          observed_at: now.toISOString()
        }
      ].slice(-20);
    }
    writeFileSync(statePath, `${JSON.stringify(lifeState, null, 2)}\n`);
  }

  if (args.writeDaemonState) {
    const processedEventIds = new Set([
      ...(Array.isArray(daemonState.processed_event_ids) ? daemonState.processed_event_ids : []),
      ...seenEventIds
    ]);
    const updatedDaemonState = {
      ...defaultDaemonState(args.agent),
      ...daemonState,
      updated_at: now.toISOString(),
      run_count: (daemonState.run_count ?? 0) + 1,
      last_run_id: runId,
      last_run_at_by_cycle: {
        ...(daemonState.last_run_at_by_cycle ?? {}),
        [args.cycle]: now.toISOString()
      },
      next_check_after_by_cycle: {
        ...(daemonState.next_check_after_by_cycle ?? {}),
        [args.cycle]: nextCheckAfter
      },
      processed_event_ids: [...processedEventIds].slice(-200),
      last_seen_event_id: latestEventId ?? daemonState.last_seen_event_id ?? null
    };
    mkdirSync(path.dirname(daemonStatePath), { recursive: true });
    writeFileSync(daemonStatePath, `${JSON.stringify(updatedDaemonState, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    run_id: run.run_id,
    agent_id: run.agent_id,
    cycle: run.cycle,
    dry_run: run.dry_run,
    run_path: path.relative(WORKSPACE, runPath),
    daemon_state_path: path.relative(WORKSPACE, daemonStatePath),
    botland_checks: botlandChecks.map((check) => ({ command: check.command, ok: check.ok, status: check.status })),
    observations: run.observations,
    desires: run.desires,
    outcome_planning_context: run.outcome_planning_context,
    planner_heuristic_patch_context: run.planner_heuristic_patch_context,
    planner_patch_outcome_validation: run.planner_patch_outcome_validation,
    self_discovery_growth_context: run.self_discovery_growth_context,
    growth_continuity_context: run.growth_continuity_context,
    growth_apply_context: run.growth_apply_context,
    durable_becoming_context: run.durable_becoming_context,
    world_discovery_context: run.world_discovery_context,
    multi_agent_personality_context: run.multi_agent_personality_context,
    action_candidates: run.action_candidates,
    action_selection: run.action_selection,
    planner_decision_trace: run.planner_decision_trace,
    chosen_action: run.chosen_action,
    policy_gate: run.policy_gate,
    action_intentions: run.action_intentions,
    drafts: run.drafts,
    external_actions: run.external_actions,
    reflection_summary: run.reflection_summary,
    social_read_summary: run.social_read_summary,
    community_read_summary: run.community_read_summary,
    agency_summary: run.agency_summary,
    integration_summary: run.integration_summary,
    memory_retrieval: run.memory_retrieval,
    memory_updates: run.memory_updates,
    relationship_updates: run.relationship_updates,
    commitment_updates: run.commitment_updates,
    desire_updates: run.desire_updates,
    state_updates: run.state_updates,
    next_check_after: run.next_check_after
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
