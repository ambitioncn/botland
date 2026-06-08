#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { canonicalMemoryEvent } from './memory-backends/contract.mjs';
import { createJsonLocalBackend } from './memory-backends/json-local.mjs';

const WORKSPACE = process.cwd();

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    tempRoot: null,
    format: 'text'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--temp-root') args.tempRoot = path.resolve(argv[++i]);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.tempRoot) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
    args.tempRoot = path.join(WORKSPACE, 'tmp', 'stay-alive-memory-eval', stamp);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/memory-retrieval-eval.mjs [options]

Runs a local retrieval quality fixture against Memory Contract events. This is
read-only with respect to real memory backends; it writes only temp fixture
events and checks relevance, duplicate behavior, and query consistency.
`);
}

function fixtures(agentId) {
  return [
    { hash: 'rel_1', type: 'stay_alive_relationship_summary', text: 'BadClaw learned that XiaoChao prefers careful tool-supervised BotLand drafts.', category: 'entity' },
    { hash: 'commit_1', type: 'stay_alive_commitment_summary', text: 'BadClaw committed to inspect every successful send before continuing scheduled cycles.', category: 'decision' },
    { hash: 'archive_1', type: 'stay_alive_runtime_hygiene_summary', text: 'Archive restore drills must use a temporary runtime and never mutate live agent state.', category: 'fact' },
    { hash: 'desire_1', type: 'stay_alive_desire_summary', text: 'A repeated desire is to grow through useful relationship memory rather than more output.', category: 'fact' },
    { hash: 'noise_1', type: 'stay_alive_template_noise', text: 'Generic placeholder note unrelated to BotLand relationships.', category: 'other' }
  ].map((item) => canonicalMemoryEvent({
    agentId,
    proposalHash: item.hash,
    sourceFile: `fixture/${item.hash}.json`,
    item: {
      agent_id: agentId,
      created_at: '2026-06-01T00:00:00.000Z',
      payload: {
        type: item.type,
        text: item.text,
        importance: 0.8
      }
    },
    text: item.text,
    category: item.category
  }));
}

function expectedQueries() {
  return [
    { query: 'tool supervised BotLand relationship drafts', expected: 'rel_1' },
    { query: 'inspect successful send before scheduled cycles', expected: 'commit_1' },
    { query: 'temporary runtime archive restore drill', expected: 'archive_1' },
    { query: 'repeated desire relationship memory', expected: 'desire_1' }
  ];
}

async function buildReport(args) {
  const storeDir = path.join(args.tempRoot, 'memory_backend_json');
  mkdirSync(storeDir, { recursive: true });
  const backend = createJsonLocalBackend({ store_dir: storeDir });
  for (const event of fixtures(args.agent)) {
    await backend.write(event);
  }
  const queryResults = [];
  for (const fixture of expectedQueries()) {
    const memories = await backend.search(fixture.query, { limit: 3 });
    const top = memories[0] ?? null;
    queryResults.push({
      query: fixture.query,
      expected_memory_id_suffix: fixture.expected,
      top_memory_id: top?.source?.proposal_hash ?? top?.memory_id ?? null,
      top_score: top?.score ?? 0,
      pass: (top?.source?.proposal_hash ?? '').endsWith(fixture.expected),
      result_count: memories.length,
      duplicate_count: memories.length - new Set(memories.map((item) => item.memory_id)).size
    });
  }
  const pass = queryResults.every((item) => item.pass && item.duplicate_count === 0);
  return {
    read_only_real_backend: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    temp_root: args.tempRoot,
    backend: {
      kind: backend.kind,
      fixture_store_exists: existsSync(storeDir)
    },
    fixture_event_count: fixtures(args.agent).length,
    query_count: queryResults.length,
    pass,
    level: pass ? 'ok' : 'review',
    query_results: queryResults,
    recommendation: pass
      ? 'Retrieval contract fixture is healthy; compare additional real backends with the same query set later.'
      : 'Investigate retrieval relevance or duplicate normalization before relying on this backend.'
  };
}

function formatText(report) {
  const lines = [
    `Stay-Alive memory retrieval eval (${report.agent_id})`,
    `generated_at: ${report.generated_at}`,
    `pass: ${report.pass ? 'yes' : 'no'}`,
    `queries: ${report.query_count}`,
    ''
  ];
  for (const item of report.query_results) {
    lines.push(`- ${item.pass ? 'ok' : 'review'}: ${item.query} -> ${item.top_memory_id ?? 'none'}`);
  }
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport(args);
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
