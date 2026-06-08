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
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/self-model-evolution-proposal.mjs [options]

Read-only self-model evolution proposal. It converts repeated desire/self-review
evidence into a tool-supervised patch suggestion, but never writes life_state.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listJson(dir, limit) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name)).sort().reverse().slice(0, limit);
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function key(text) {
  return normalize(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ').split(/\s+/).filter((item) => item.length > 1).slice(0, 8).join(' ');
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const lifeState = readJson(path.join(agentDir, 'life_state.json'));
  const runs = listJson(path.join(agentDir, 'runs'), args.limit).map((file) => {
    try {
      return { file, run: readJson(file) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const reflectRuns = runs.filter((item) => item.run.cycle === 'reflect');
  const candidates = reflectRuns.flatMap((item) => {
    const summary = item.run.reflection_summary ?? {};
    const desireCandidates = summary.desire_candidates ?? [];
    const deliberation = summary.reflect_deliberation ?? {};
    return [
      ...desireCandidates.map((candidate) => ({
        source: 'desire_candidate',
        run_id: item.run.run_id,
        text: normalize(candidate.text)
      })),
      deliberation.living_reason ? {
        source: 'living_reason',
        run_id: item.run.run_id,
        text: normalize(deliberation.living_reason)
      } : null,
      deliberation.chosen_stance ? {
        source: 'chosen_stance',
        run_id: item.run.run_id,
        text: normalize(deliberation.chosen_stance)
      } : null
    ].filter((entry) => entry?.text);
  });
  const groups = new Map();
  for (const item of candidates) {
    const groupKey = key(item.text);
    if (!groupKey) continue;
    const group = groups.get(groupKey) ?? [];
    group.push(item);
    groups.set(groupKey, group);
  }
  const repeated = [...groups.entries()]
    .filter(([, items]) => items.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .map(([groupKey, items]) => ({
      key: groupKey,
      evidence_count: items.length,
      examples: items.slice(0, 3)
    }));
  const currentValues = Array.isArray(lifeState.self_model?.values) ? lifeState.self_model.values : [];
  const currentBoundaries = Array.isArray(lifeState.self_model?.boundaries) ? lifeState.self_model.boundaries : [];
  const top = repeated[0] ?? null;
  const proposedValue = top
    ? `Treat repeated evidence about "${top.key}" as a reviewed continuity theme, not an automatic identity rewrite.`
    : null;
  const patch = top ? [{
    op: 'add',
    path: 'self_model.values',
    value: proposedValue,
    evidence_key: top.key,
    evidence_count: top.evidence_count
  }] : [];
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    proposal_schema: 'stay_alive.self_model_evolution_proposal.v1',
    current_self_model: {
      name: lifeState.self_model?.name ?? null,
      value_count: currentValues.length,
      boundary_count: currentBoundaries.length
    },
    evidence: {
      reflect_run_count: reflectRuns.length,
      candidate_count: candidates.length,
      repeated_theme_count: repeated.length,
      repeated_themes: repeated
    },
    proposed_patch: patch,
    tool_supervision_required: true,
    confidence: top ? Math.min(0.9, 0.45 + top.evidence_count * 0.1) : 0.2,
    recommendation: top
      ? 'Create a normal proposal/state governance item only after tool supervision; do not mutate life_state directly.'
      : 'Keep collecting reflection evidence before proposing self-model changes.',
    safety: {
      life_state_mutated: false,
      proposal_written: false
    }
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive self-model evolution proposal (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `repeated_themes: ${report.evidence.repeated_theme_count}`,
    `proposed_patch_items: ${report.proposed_patch.length}`,
    `tool_supervision_required: ${report.tool_supervision_required ? 'yes' : 'no'}`,
    '',
    `recommendation: ${report.recommendation}`,
    'life_state_mutated: no'
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
