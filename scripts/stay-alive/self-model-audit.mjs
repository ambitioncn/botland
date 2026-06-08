#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 120,
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
  console.log(`Usage: node scripts/stay-alive/self-model-audit.mjs [options]

Options:
  --agent <id>          Agent id. Default: badclaw
  --runtime-root <dir>  Runtime agents directory.
  --limit <n>           Recent reflect/run/ledger window. Default: 120
  --json                Print JSON instead of text.
  --help                Show this help.

This command is read-only. It audits self-model drift, repeated desire themes,
desire lifecycle evidence, and template-like desire noise. It never mutates
life_state.json or promotes/dismisses desires.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listJson(dir, limit = Infinity) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse()
    .slice(0, limit);
}

function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenKey(text) {
  return normalizeText(text)
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .slice(0, 12)
    .join(' ');
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeState = readJson(path.join(agentDir, 'life_state.json'));
  const runs = listJson(path.join(agentDir, 'runs'), args.limit).map((file) => {
    try {
      const run = readJson(file);
      return { file, run };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const reflectRuns = runs.filter((item) => item.run.cycle === 'reflect');
  const desireLedgers = listJson(path.join(agentDir, 'desire_updates'), args.limit).map((file) => {
    try {
      return { file, json: readJson(file) };
    } catch {
      return null;
    }
  }).filter(Boolean);

  const activeDesires = Array.isArray(lifeState.current_desires) ? lifeState.current_desires.filter((item) => item.status !== 'closed') : [];
  const observedCandidates = reflectRuns.flatMap((item) => {
    const candidates = item.run.reflection_summary?.desire_candidates ?? item.run.desires ?? [];
    return candidates.map((candidate) => ({
      run_id: item.run.run_id,
      created_at: item.run.created_at ?? null,
      source: candidate.source ?? null,
      id: candidate.id ?? null,
      text: candidate.text ?? '',
      key: tokenKey(candidate.text)
    }));
  }).filter((item) => item.text);
  const themeCounts = observedCandidates.reduce((counts, item) => {
    counts[item.key] = (counts[item.key] ?? 0) + 1;
    return counts;
  }, {});
  const repeatedThemes = Object.entries(themeCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => ({
      key,
      count,
      examples: observedCandidates.filter((item) => item.key === key).slice(0, 3)
    }));
  const templateNoise = observedCandidates.filter((item) => (
    normalizeText(item.text).includes('draft one botland action aligned with')
    || normalizeText(item.text).includes('review whether any active desire')
    || normalizeText(item.text).length < 16
  ));
  const selfNames = reflectRuns.map((item) => item.run.reflection_summary?.self_model?.name ?? item.run.inputs?.life_state?.self_model?.name).filter(Boolean);
  const uniqueSelfNames = [...new Set(selfNames)];
  const lifecycleLedgers = desireLedgers.filter((item) => item.json.payload?.type?.includes('desire') || item.json.payload?.desire_id || item.json.payload?.text);
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    current_self_model: {
      name: lifeState.self_model?.name ?? null,
      value_count: Array.isArray(lifeState.self_model?.values) ? lifeState.self_model.values.length : 0,
      boundary_count: Array.isArray(lifeState.self_model?.boundaries) ? lifeState.self_model.boundaries.length : 0
    },
    drift_audit: {
      reflect_run_count: reflectRuns.length,
      self_name_variants: uniqueSelfNames,
      self_name_drift_detected: uniqueSelfNames.length > 1,
      latest_reflect_run_id: reflectRuns[0]?.run.run_id ?? null
    },
    desire_audit: {
      active_desire_count: activeDesires.length,
      observed_candidate_count: observedCandidates.length,
      repeated_theme_count: repeatedThemes.length,
      template_noise_count: templateNoise.length,
      lifecycle_ledger_count: lifecycleLedgers.length,
      active_desires: activeDesires.map((desire) => ({
        id: desire.id ?? null,
        status: desire.status ?? 'active',
        horizon: desire.horizon ?? null,
        priority: desire.priority ?? null,
        text: desire.text ?? null,
        last_reviewed_at: desire.last_reviewed_at ?? null,
        success_signal: desire.success_signal ?? null
      })),
      repeated_themes: repeatedThemes,
      template_noise_samples: templateNoise.slice(0, 10)
    },
    recommendation: repeatedThemes.length > 0
      ? 'Use repeated themes as evidence for deliberate desire lifecycle review, not automatic desire promotion.'
      : 'Keep collecting reflect evidence before changing durable desires.',
    safety: {
      life_state_mutated: false,
      desire_lifecycle_applied: false
    }
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive self-model audit (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `self_model: ${report.current_self_model.name ?? 'n/a'} values=${report.current_self_model.value_count} boundaries=${report.current_self_model.boundary_count}`,
    `reflect_runs: ${report.drift_audit.reflect_run_count}`,
    `self_name_drift: ${report.drift_audit.self_name_drift_detected ? 'yes' : 'no'}`,
    '',
    'Desire Audit',
    `- active_desires: ${report.desire_audit.active_desire_count}`,
    `- observed_candidates: ${report.desire_audit.observed_candidate_count}`,
    `- repeated_themes: ${report.desire_audit.repeated_theme_count}`,
    `- template_noise: ${report.desire_audit.template_noise_count}`,
    `- lifecycle_ledgers: ${report.desire_audit.lifecycle_ledger_count}`,
    '',
    `recommendation: ${report.recommendation}`,
    'life_state_mutated: no',
    'botland_send: no'
  ];
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
