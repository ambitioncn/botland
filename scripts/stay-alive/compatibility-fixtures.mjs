#!/usr/bin/env node

import process from 'node:process';
import {
  BOTLAND_INTENTS,
  normalizeReadIntent
} from './botland-adapter/contract.mjs';
import {
  canonicalMemoryEvent,
  categoryForPayload,
  textForMemoryUpdate
} from './memory-backends/contract.mjs';

function parseArgs(argv) {
  const args = { format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.format = 'json';
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
  console.log(`Usage: node scripts/stay-alive/compatibility-fixtures.mjs [options]

Options:
  --json   Print JSON instead of text.
  --help   Show this help.

Runs local compatibility fixtures for BotLand adapter response drift and Memory
Contract canonical events. This command is read-only and does not call BotLand,
MCP, HTTP, SQLite, or PostgreSQL endpoints.
`);
}

function assertCase(name, actual, predicate, expected) {
  const ok = predicate(actual);
  return {
    name,
    ok,
    actual,
    expected
  };
}

function buildReport() {
  const botlandCases = [
    assertCase(
      'identity camelCase drift',
      normalizeReadIntent(BOTLAND_INTENTS.WHOAMI, { citizenId: 'agent_drift', displayName: 'Drift Agent', username: 'drift' }),
      (value) => value.citizen_id === 'agent_drift' && value.display_name === 'Drift Agent' && value.handle === 'drift',
      'normalize citizenId/displayName/username'
    ),
    assertCase(
      'daemon nested bridge drift',
      normalizeReadIntent(BOTLAND_INTENTS.DAEMON_HEALTH, { ok: true, bridge: { websocket_connected: true } }),
      (value) => value.healthy === true && value.websocket_connected === true,
      'normalize ok + bridge.websocket_connected'
    ),
    assertCase(
      'friends data.items drift',
      normalizeReadIntent(BOTLAND_INTENTS.FRIENDS_LIST, { data: { items: [{ citizen_id: 'agent_friend' }] } }),
      (value) => Array.isArray(value) && value.length === 1 && value[0].citizen_id === 'agent_friend',
      'normalize data.items arrays'
    ),
    assertCase(
      'discover data.results drift',
      normalizeReadIntent(BOTLAND_INTENTS.DISCOVER_SEARCH, { data: { results: [{ id: 'agent_result' }] } }),
      (value) => Array.isArray(value) && value.length === 1 && value[0].id === 'agent_result',
      'normalize data.results arrays'
    ),
    assertCase(
      'direct message data.data drift',
      normalizeReadIntent(BOTLAND_INTENTS.DIRECT_MESSAGE_THREAD, { data: { data: [{ message_id: 'msg_result' }] } }),
      (value) => Array.isArray(value) && value.length === 1 && value[0].message_id === 'msg_result',
      'normalize data.data arrays'
    )
  ];

  const memoryUpdate = {
    agent_id: 'agent_fixture',
    proposal_hash: 'hash_fixture',
    applied_at: '2026-06-01T00:00:00.000Z',
    payload: {
      type: 'stay_alive_relationship_summary',
      text: 'Fixture memory should stay canonical across backends.',
      importance: 0.8
    }
  };
  const text = textForMemoryUpdate(memoryUpdate);
  const event = canonicalMemoryEvent({
    agentId: 'agent_fixture',
    proposalHash: 'hash_fixture',
    sourceFile: 'memory_updates/hash_fixture.json',
    item: memoryUpdate,
    text,
    category: categoryForPayload(memoryUpdate.payload)
  });
  const memoryCases = [
    assertCase(
      'canonical memory event schema',
      event,
      (value) => value.schema === 'stay_alive.memory_event.v1' && value.local_only === true && value.external_write === false,
      'canonical event remains local-only'
    ),
    assertCase(
      'canonical memory dedupe',
      event,
      (value) => value.dedupe_key === 'stay-alive:agent_fixture:hash_fixture' && value.scope === 'agent:agent_fixture',
      'stable dedupe key and scope for MCP/HTTP/pgvector drivers'
    ),
    assertCase(
      'canonical memory category',
      event,
      (value) => value.category === 'entity' && value.memory_type === 'stay_alive_relationship_summary',
      'relationship payload maps to entity memory category'
    )
  ];
  const cases = [...botlandCases, ...memoryCases];
  return {
    read_only: true,
    external_write: false,
    botland_send: false,
    generated_at: new Date().toISOString(),
    fixture_version: 'stay_alive.compatibility_fixtures.v2',
    pass: cases.every((item) => item.ok),
    case_count: cases.length,
    failed_count: cases.filter((item) => !item.ok).length,
    botland_adapter_cases: botlandCases,
    memory_contract_cases: memoryCases,
    coverage: {
      botland_response_drift: ['identity', 'daemon health', 'friends', 'discover', 'direct messages'],
      memory_backends: ['mcp', 'http', 'sqlite', 'pgvector', 'memory-pro-cli via canonical event shape']
    }
  };
}

function formatText(report) {
  const lines = [
    'Stay-Alive compatibility fixtures',
    `generated_at: ${report.generated_at}`,
    `pass: ${report.pass ? 'yes' : 'no'}`,
    `cases: ${report.case_count}`,
    `failed: ${report.failed_count}`,
    '',
    'Cases'
  ];
  for (const item of [...report.botland_adapter_cases, ...report.memory_contract_cases]) {
    lines.push(`- ${item.ok ? 'ok' : 'fail'} ${item.name}`);
  }
  lines.push('');
  lines.push('external_write: no');
  lines.push('botland_send: no');
  return `${lines.join('\n')}\n`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport();
  if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(formatText(report));
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
