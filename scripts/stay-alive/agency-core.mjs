#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME_ROOT = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    limit: 40,
    output: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--output') args.output = path.resolve(argv[++i]);
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
  console.log(`Usage: node scripts/stay-alive/agency-core.mjs [options]

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory.
  --limit <n>              Recent run artifacts to inspect. Default: 40
  --output <file>          Optional JSON report path.
  --json                   Print JSON instead of text.
  --help                   Show this help.

Agency Core is read-only. It evaluates whether the agent is forming its own
questions, intrinsic desires, low-risk private experiments, and growth journal
instead of merely moving through operator governance.
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

function listRecentRuns(agentDir, limit) {
  const runsDir = path.join(agentDir, 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(readJsonOrNull)
    .filter(Boolean);
}

function listPrivateGrowthJournals(agentDir, limit = 20) {
  const journalDir = path.join(agentDir, 'agency_journal');
  if (!existsSync(journalDir)) return [];
  return readdirSync(journalDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(journalDir, name))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(readJsonOrNull)
    .filter((item) => item?.schema === 'stay_alive.private_growth_journal.v1');
}

function sentenceClamp(text, maxLength = 220) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

function countBy(items, fn) {
  const out = {};
  for (const item of items) {
    const key = fn(item);
    if (!key) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function buildReport(args) {
  const generatedAt = new Date().toISOString();
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeStatePath = path.join(agentDir, 'life_state.json');
  if (!existsSync(lifeStatePath)) throw new Error(`Missing life_state.json: ${lifeStatePath}`);
  const lifeState = readJson(lifeStatePath);
  const runs = listRecentRuns(agentDir, args.limit);
  const privateGrowthJournals = listPrivateGrowthJournals(agentDir);
  const chosenCounts = countBy(runs, (run) => run.chosen_action?.type ?? run.action_selection?.selected_type ?? null);
  const cycleCounts = countBy(runs, (run) => run.cycle);
  const name = lifeState.self_model?.name ?? lifeState.agent_id ?? args.agent;
  const values = Array.isArray(lifeState.self_model?.values) ? lifeState.self_model.values : [];
  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  const desires = Array.isArray(lifeState.current_desires)
    ? lifeState.current_desires.filter((item) => item.status !== 'closed')
    : [];
  const operatorControlCount = (chosenCounts.reflection_proposal ?? 0)
    + (chosenCounts.memory_proposal ?? 0)
    + (chosenCounts.local_maintenance ?? 0);
  const journalExperimentTypes = [...new Set(privateGrowthJournals.map((item) => item.experiment_type).filter(Boolean))];
  const runIds = new Set(runs.map((run) => run.run_id).filter(Boolean));
  const recentJournalCount = privateGrowthJournals.filter((item) => item.source_run_id && runIds.has(item.source_run_id)).length;
  const journalContinuity = {
    schema: 'stay_alive.private_growth_journal_continuity.v1',
    journal_count: privateGrowthJournals.length,
    recent_journal_count: recentJournalCount,
    experiment_type_count: journalExperimentTypes.length,
    experiment_types: journalExperimentTypes,
    continuity_verdict: privateGrowthJournals.length >= 3 && journalExperimentTypes.length >= 2
      ? 'growth_thread_visible'
      : privateGrowthJournals.length > 0
        ? 'growth_thread_seeded'
        : 'growth_thread_missing',
    latest: privateGrowthJournals.slice(0, 3).map((item) => ({
      journal_id: item.journal_id ?? null,
      generated_at: item.generated_at ?? null,
      source_run_id: item.source_run_id ?? null,
      source_experiment_id: item.source_experiment_id ?? null,
      experiment_type: item.experiment_type ?? null,
      entry_preview: sentenceClamp(item.journal_entry?.text ?? '')
    }))
  };
  const agentBecomingCount = (chosenCounts.agency_experiment_plan ?? 0)
    + desires.length
    + runs.filter((run) => run.agency_summary?.schema === 'stay_alive.agency_core.v1').length
    + privateGrowthJournals.length
    + journalExperimentTypes.length;
  const autonomyScore = clamp(
    50
      + Math.min(18, desires.length * 4)
      + Math.min(12, relationships.length * 2)
      + Math.min(14, agentBecomingCount * 3)
      + Math.min(12, privateGrowthJournals.length * 3)
      + Math.min(6, journalExperimentTypes.length * 2)
      - Math.min(22, operatorControlCount * 2),
    0,
    100
  );
  const questions = [
    {
      question: `What does ${name} care about now that was not directly assigned by an operator?`,
      evidence_hint: desires[0]?.text ?? lifeState.life_theme ?? values[0] ?? 'no durable desire yet'
    },
    {
      question: `Which remembered relationship should change ${name}'s next private experiment?`,
      evidence_hint: relationships[0]?.name ?? relationships[0]?.target_id ?? 'no relationship selected yet'
    },
    {
      question: `What did ${name} learn about itself from recent cycles, beyond pass/fail status?`,
      evidence_hint: `${runs.length} recent run artifact(s), cycles: ${Object.keys(cycleCounts).join(', ') || 'none'}`
    }
  ];
  const intrinsicDesires = [
    {
      text: desires[0]?.text ?? `Grow a stable internal direction from ${lifeState.life_theme ?? values[0] ?? 'identity continuity'}.`,
      source: desires[0] ? 'life_state.current_desires' : 'agency_core_seed',
      intrinsic: true,
      not_event_mapped: true,
      horizon: desires[0]?.horizon ?? 'medium'
    },
    {
      text: 'Turn one memory into self-understanding instead of another operational artifact.',
      source: 'agency_core_v1',
      intrinsic: true,
      not_event_mapped: true,
      horizon: 'medium'
    }
  ];
  const experiments = [
    {
      type: 'private_growth_journal',
      summary: 'Write one private paragraph: what changed in me, what I want next, and what boundary keeps it safe.',
      external_write: false,
      requires_confirmation: false
    },
    {
      type: 'relationship_hypothesis',
      summary: relationships.length > 0
        ? `Re-read the evidence for ${relationships[0].name ?? relationships[0].target_id} and name one changed understanding.`
        : 'Find one observed person worth a first relationship hypothesis.',
      external_write: false,
      requires_confirmation: false
    }
  ];
  return {
    schema: 'stay_alive.agency_core_report.v1',
    generated_at: generatedAt,
    agent_id: args.agent,
    read_only: true,
    external_write: false,
    life_state_path: path.relative(WORKSPACE, lifeStatePath),
    inspected_run_count: runs.length,
    cycle_counts: cycleCounts,
    chosen_action_counts: chosenCounts,
    self_discovery: {
      questions,
      becoming_hypothesis: `${name} is closer to the intended product when it can author questions, desires, experiments, and growth memory before the operator decides anything.`
    },
    intrinsic_desires: intrinsicDesires,
    autonomous_experiments: experiments,
    growth_journal_seed: {
      text: `${name} should use safety systems as a boundary for becoming, not as a substitute for becoming.`,
      evidence: {
        operator_control_count: operatorControlCount,
        agent_becoming_count: agentBecomingCount,
        active_desire_count: desires.length,
        private_growth_journal_count: privateGrowthJournals.length,
        private_growth_experiment_type_count: journalExperimentTypes.length,
        private_growth_journal_verdict: journalContinuity.continuity_verdict
      }
    },
    private_growth_journal: {
      schema: 'stay_alive.private_growth_journal_index.v1',
      count: privateGrowthJournals.length,
      continuity: journalContinuity,
      latest: privateGrowthJournals.slice(0, 3).map((item) => ({
        journal_id: item.journal_id ?? null,
        generated_at: item.generated_at ?? null,
        source_experiment_id: item.source_experiment_id ?? null,
        entry: item.journal_entry?.text ?? null
      }))
    },
    agency_evaluation: {
      autonomy_score: autonomyScore,
      verdict: autonomyScore >= 72
        ? 'agent_becoming_visible'
        : autonomyScore >= 55
          ? 'agency_seeded_but_operator_heavy'
          : 'operator_control_dominant',
      recommendation: 'Prioritize agency cycle outputs over additional operator dashboards until growth memory and intrinsic desires are visible in normal runs.'
    }
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`Agency Core (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: ${report.read_only}`);
  lines.push(`external_write: ${report.external_write}`);
  lines.push(`autonomy_score: ${report.agency_evaluation.autonomy_score}`);
  lines.push(`verdict: ${report.agency_evaluation.verdict}`);
  lines.push('');
  lines.push('Self Questions');
  for (const item of report.self_discovery.questions) lines.push(`- ${item.question}`);
  lines.push('');
  lines.push('Intrinsic Desires');
  for (const item of report.intrinsic_desires) lines.push(`- ${item.text}`);
  lines.push('');
  lines.push('Autonomous Experiments');
  for (const item of report.autonomous_experiments) lines.push(`- ${item.summary}`);
  lines.push('');
  lines.push(`Recommendation: ${report.agency_evaluation.recommendation}`);
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.output) writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
