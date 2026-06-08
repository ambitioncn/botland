#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents'),
    limit: 200,
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
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be positive');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/feedback-calibration-report.mjs [options]

Read-only calibration report for action outcome maturity. It aggregates
inspected sends, replies, likes, comments, stale/no-feedback outcomes, and
policy tuning suggestions without modifying relationship, commitment, desire,
memory, or BotLand state.
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function listJson(dir, limit) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort()
    .reverse()
    .slice(0, limit);
}

function inc(map, key) {
  map[key ?? 'unknown'] = (map[key ?? 'unknown'] ?? 0) + 1;
}

function buildReport(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const outcomes = listJson(path.join(agentDir, 'action_outcomes'), args.limit).map((file) => {
    try {
      return { path: path.relative(WORKSPACE, file), json: readJson(file) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const byStatus = {};
  const byActionType = {};
  const bySignal = {};
  const byMaturity = {};
  const stale = [];
  const strong = [];
  let textFeedback = 0;
  let ambientOnly = 0;
  for (const item of outcomes) {
    const json = item.json;
    const interpretation = json.observation?.feedback_interpretation ?? {};
    inc(byStatus, json.outcome_status);
    inc(byActionType, json.action_type);
    inc(bySignal, interpretation.signal_strength);
    inc(byMaturity, interpretation.maturity);
    if (interpretation.has_text_feedback) textFeedback += 1;
    if (interpretation.has_ambient_feedback && !interpretation.has_text_feedback) ambientOnly += 1;
    if (interpretation.close_policy?.stale_attention || json.outcome_status?.includes('stale')) stale.push(item);
    if (['strong_positive', 'strong_negative'].includes(interpretation.signal_strength)) strong.push(item);
  }
  const noFeedback = (byStatus.no_feedback_yet ?? 0) + (byStatus.stale_pending_close ?? 0) + (byStatus.stale_closed ?? 0);
  const suggestions = [];
  if (outcomes.length === 0) suggestions.push('Collect inspected send outcomes before tuning policy.');
  if (textFeedback === 0 && outcomes.length > 0) suggestions.push('Do not promote relationship/commitment/desire changes yet; current evidence is mostly silence or ambient.');
  if (ambientOnly > textFeedback) suggestions.push('Keep ambient likes/comments weak unless text feedback appears from a named actor.');
  if (stale.length > 0) suggestions.push('Review stale close windows; close silent outcomes locally before relationship learning.');
  if (strong.length > 0) suggestions.push('Strong textual feedback can become proposal evidence, but still route through governance.');
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    scanned_outcome_count: outcomes.length,
    by_status: byStatus,
    by_action_type: byActionType,
    by_signal_strength: bySignal,
    by_maturity: byMaturity,
    text_feedback_count: textFeedback,
    ambient_only_count: ambientOnly,
    no_feedback_or_stale_count: noFeedback,
    stale_attention_count: stale.length,
    strong_signal_count: strong.length,
    samples: {
      stale_attention: stale.slice(0, 10).map((item) => ({ path: item.path, outcome_id: item.json.outcome_id, status: item.json.outcome_status })),
      strong_signal: strong.slice(0, 10).map((item) => ({ path: item.path, outcome_id: item.json.outcome_id, signal: item.json.observation?.feedback_interpretation?.signal_strength }))
    },
    policy_tuning_suggestions: suggestions,
    safety: {
      report_only: true,
      relationship_mutated: false,
      commitment_mutated: false,
      desire_mutated: false
    }
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive feedback calibration (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `outcomes: ${report.scanned_outcome_count}`,
    `text_feedback: ${report.text_feedback_count}`,
    `ambient_only: ${report.ambient_only_count}`,
    `stale_attention: ${report.stale_attention_count}`,
    `strong_signal: ${report.strong_signal_count}`,
    '',
    'Suggestions'
  ];
  for (const item of report.policy_tuning_suggestions) lines.push(`- ${item}`);
  lines.push('');
  lines.push('report_only: yes');
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
