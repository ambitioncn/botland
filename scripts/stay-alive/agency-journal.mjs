#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 80,
    dryRun: false,
    allUnseen: false,
    format: 'text',
    output: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--all-unseen') args.allUnseen = true;
    else if (arg === '--json') args.format = 'json';
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
  console.log(`Usage: node scripts/stay-alive/agency-journal.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --limit <n>              Recent run artifacts to inspect. Default: 80
  --dry-run                Build the journal artifact without writing it.
  --all-unseen             Journal every unseen private experiment in the latest agency run.
  --output <file>          Optional JSON report path.
  --json                   Print JSON instead of text.
  --help                   Show this help.

Agency Journal converts a recent agency cycle's private experiment into a local
growth artifact. It never sends, posts, joins, reports, or mutates life_state.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJsonOrNull(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function listJsonFiles(dir, limit = null) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse();
  return limit ? files.slice(0, limit) : files;
}

function latestAgencyRun(agentDir, limit) {
  const runsDir = path.join(agentDir, 'runs');
  for (const file of listJsonFiles(runsDir, limit)) {
    const run = readJsonOrNull(file);
    if (run?.agency_summary?.schema === 'stay_alive.agency_core.v1') {
      return { file, run };
    }
  }
  return null;
}

function existingExperimentIds(journalDir) {
  const ids = new Set();
  for (const file of listJsonFiles(journalDir)) {
    const artifact = readJsonOrNull(file);
    if (artifact?.source_experiment_id) ids.add(artifact.source_experiment_id);
  }
  return ids;
}

function compactStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildJournalArtifact({ args, now, lifeState, agencyRun, summary, experiment, question, desire, index }) {
  const name = lifeState.self_model?.name ?? lifeState.agent_id ?? args.agent;
  const suffix = index === 0 ? '' : `_${String(index + 1).padStart(2, '0')}`;
  const journalId = `agency_journal_${compactStamp(now)}_${args.agent}${suffix}`;
  const journalDir = path.join(path.dirname(path.dirname(agencyRun.file)), 'agency_journal');
  const journalPath = path.join(journalDir, `${journalId}.json`);
  const entryText = `${name} chose a private ${experiment.type ?? 'agency'} experiment because "${normalize(question?.question)}" still matters. The growth signal is: ${normalize(experiment.expected_growth_signal)}`;

  return {
    path: journalPath,
    artifact: {
      schema: 'stay_alive.private_growth_journal.v1',
      journal_id: journalId,
      generated_at: now.toISOString(),
      agent_id: args.agent,
      local_only: true,
      external_write: false,
      botland_send: false,
      life_state_mutated: false,
      dry_run: args.dryRun,
      source_run_id: agencyRun?.run?.run_id ?? null,
      source_run_path: agencyRun ? path.relative(WORKSPACE, agencyRun.file) : null,
      source_experiment_id: experiment?.experiment_id ?? null,
      experiment_type: experiment?.type ?? null,
      self_question: question,
      intrinsic_desire: desire,
      journal_entry: {
        topic: 'private_agency_experiment',
        text: entryText,
        chosen_private_experiment: experiment?.summary ?? null,
        expected_growth_signal: experiment?.expected_growth_signal ?? null,
        integration_hint: 'Use this as growth evidence in future agency/reflection cycles; do not treat it as permission for external action.'
      },
      safety: {
        requires_external_gate: false,
        public_surface_touched: false,
        botland_surface_touched: false,
        proposal_queue_required_to_exist: false
      }
    }
  };
}

function buildJournal(args) {
  const now = new Date();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(lifeStatePath)) throw new Error(`Missing life_state.json: ${lifeStatePath}`);
  const lifeState = readJson(lifeStatePath);
  const agencyRun = latestAgencyRun(agentDir, args.limit);
  const journalDir = path.join(agentDir, 'agency_journal');
  const seenExperimentIds = existingExperimentIds(journalDir);
  const summary = agencyRun?.run?.agency_summary ?? null;
  const experiments = Array.isArray(summary?.autonomous_experiments) ? summary.autonomous_experiments : [];
  const unseenExperiments = experiments.filter((item) => item?.experiment_id && !seenExperimentIds.has(item.experiment_id));
  const selectedExperiments = args.allUnseen ? unseenExperiments : unseenExperiments.slice(0, 1);
  const question = summary?.self_discovery?.questions?.[0] ?? null;
  const desire = summary?.intrinsic_desires?.find((item) => item?.intrinsic && item?.not_event_mapped)
    ?? summary?.intrinsic_desires?.[0]
    ?? null;
  const name = lifeState.self_model?.name ?? lifeState.agent_id ?? args.agent;
  const hasCandidate = Boolean(summary && selectedExperiments.length > 0);
  const journals = selectedExperiments.map((experiment, index) => buildJournalArtifact({
    args,
    now,
    lifeState,
    agencyRun,
    summary,
    experiment,
    question,
    desire,
    index
  }));
  const fallbackText = summary && experiments.length > 0
    ? `${name} has no unseen agency experiment left in the latest agency run; run a new agency cycle before writing another journal.`
    : `${name} has no agency experiment ready yet; the next useful step is to run an agency cycle and let it generate a private experiment.`;

  return {
    schema: 'stay_alive.agency_journal_result.v1',
    generated_at: now.toISOString(),
    agent_id: args.agent,
    dry_run: args.dryRun,
    all_unseen: args.allUnseen,
    local_only: true,
    external_write: false,
    has_candidate: hasCandidate,
    latest_agency_run_id: agencyRun?.run?.run_id ?? null,
    latest_experiment_count: experiments.length,
    unseen_experiment_count: unseenExperiments.length,
    selected_experiment_count: selectedExperiments.length,
    already_seen_experiment_count: experiments.length - unseenExperiments.length,
    already_seen_all_latest_experiments: Boolean(summary && experiments.length > 0 && unseenExperiments.length === 0),
    journal_path: journals[0] ? path.relative(WORKSPACE, journals[0].path) : null,
    journal_paths: journals.map((item) => path.relative(WORKSPACE, item.path)),
    artifact: journals[0]?.artifact ?? {
      schema: 'stay_alive.private_growth_journal.v1',
      journal_id: null,
      generated_at: now.toISOString(),
      agent_id: args.agent,
      local_only: true,
      external_write: false,
      botland_send: false,
      life_state_mutated: false,
      dry_run: args.dryRun,
      source_run_id: agencyRun?.run?.run_id ?? null,
      source_run_path: agencyRun ? path.relative(WORKSPACE, agencyRun.file) : null,
      source_experiment_id: null,
      experiment_type: null,
      self_question: question,
      intrinsic_desire: desire,
      journal_entry: {
        topic: 'private_agency_experiment',
        text: fallbackText,
        chosen_private_experiment: null,
        expected_growth_signal: null,
        integration_hint: 'Run a fresh agency cycle before creating more private growth journals.'
      },
      safety: {
        requires_external_gate: false,
        public_surface_touched: false,
        botland_surface_touched: false,
        proposal_queue_required_to_exist: false
      }
    },
    artifacts: journals.map((item) => item.artifact)
  };
}

function formatText(result) {
  return [
    `Agency Journal (${result.agent_id})`,
    `generated_at: ${result.generated_at}`,
    `dry_run: ${result.dry_run}`,
    `local_only: ${result.local_only}`,
    `external_write: ${result.external_write}`,
    `has_candidate: ${result.has_candidate}`,
    `all_unseen: ${result.all_unseen}`,
    `selected_experiment_count: ${result.selected_experiment_count}`,
    `journal_path: ${result.journal_path}`,
    '',
    result.artifact.journal_entry.text
  ].join('\n') + '\n';
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = buildJournal(args);
  if (!args.dryRun && result.has_candidate) {
    for (const [index, artifact] of result.artifacts.entries()) {
      const outputPath = path.join(WORKSPACE, result.journal_paths[index]);
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
    }
  }
  if (args.output) writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatText(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
