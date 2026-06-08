#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';

import { resolveMemoryBackend } from './memory-backends/resolver.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    backend: 'auto',
    query: null,
    limit: 5,
    format: 'text',
    lancedbPath: null,
    jsonStoreDir: null,
    memoryProCommand: null,
    memoryHttpUrl: null,
    memoryHttpToken: null,
    memoryHttpWritePath: null,
    memoryHttpSearchPath: null,
    memoryMcpEndpoint: null,
    memoryMcpToken: null,
    memoryMcpWriteTool: null,
    memoryMcpSearchTool: null,
    sqlitePath: null,
    sqliteTable: null,
    pgConnectionString: null,
    pgTable: null,
    psqlCommand: null,
    memoryBackendTimeoutMs: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--backend') args.backend = argv[++i];
    else if (arg === '--query') args.query = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--lancedb-path') args.lancedbPath = path.resolve(argv[++i]);
    else if (arg === '--json-store-dir') args.jsonStoreDir = path.resolve(argv[++i]);
    else if (arg === '--memory-pro-command') args.memoryProCommand = argv[++i];
    else if (arg === '--memory-http-url') args.memoryHttpUrl = argv[++i];
    else if (arg === '--memory-http-token') args.memoryHttpToken = argv[++i];
    else if (arg === '--memory-http-write-path') args.memoryHttpWritePath = argv[++i];
    else if (arg === '--memory-http-search-path') args.memoryHttpSearchPath = argv[++i];
    else if (arg === '--memory-mcp-endpoint') args.memoryMcpEndpoint = argv[++i];
    else if (arg === '--memory-mcp-token') args.memoryMcpToken = argv[++i];
    else if (arg === '--memory-mcp-write-tool') args.memoryMcpWriteTool = argv[++i];
    else if (arg === '--memory-mcp-search-tool') args.memoryMcpSearchTool = argv[++i];
    else if (arg === '--sqlite-path') args.sqlitePath = path.resolve(argv[++i]);
    else if (arg === '--sqlite-table') args.sqliteTable = argv[++i];
    else if (arg === '--pg-connection-string') args.pgConnectionString = argv[++i];
    else if (arg === '--pg-table') args.pgTable = argv[++i];
    else if (arg === '--psql-command') args.psqlCommand = argv[++i];
    else if (arg === '--memory-backend-timeout-ms') args.memoryBackendTimeoutMs = Number.parseInt(argv[++i], 10);
    else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.query || args.query.trim().length === 0) throw new Error('--query is required');
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  if (args.memoryBackendTimeoutMs !== null && (!Number.isInteger(args.memoryBackendTimeoutMs) || args.memoryBackendTimeoutMs < 1000)) {
    throw new Error('--memory-backend-timeout-ms must be an integer >= 1000');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/retrieve-memory.mjs --query <text> [options]

Read relevant Stay-Alive memories from the selected local memory backend. This
is read-only and does not call BotLand or write runtime artifacts.

Options:
  --agent <id>             Agent id. Default: badclaw
  --runtime-root <dir>     Runtime agents directory
  --backend <auto|lancedb|json-local|memory-pro-cli|mcp|http|sqlite|pgvector>
  --query <text>           Search text
  --limit <n>              Max memories. Default: 5
  --lancedb-path <dir>     Override LanceDB database path
  --json-store-dir <dir>   Override local JSON backend directory
  --memory-pro-command <cmd>
                            Override memory-pro CLI command
  --memory-http-url <url>   HTTP memory API base URL
  --memory-http-token <token>
                            HTTP memory API bearer token
  --memory-mcp-endpoint <url>
                            MCP JSON-RPC endpoint
  --memory-mcp-token <token>
                            MCP bearer token
  --memory-mcp-write-tool <name>
                            MCP write tool. Default: memory.add
  --memory-mcp-search-tool <name>
                            MCP search tool. Default: memory.search
  --sqlite-path <file>      SQLite backend file path
  --sqlite-table <name>     SQLite table name
  --pg-connection-string <dsn>
                            PostgreSQL/pgvector connection string
  --pg-table <name>         PostgreSQL table name
  --psql-command <cmd>      psql executable
  --memory-backend-timeout-ms <n>
                            Driver command timeout
  --json                   Print JSON
  --help                   Show this help
`);
}

export async function retrieveMemories(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const resolution = resolveMemoryBackend(args, { agent_dir: agentDir });
  const health = resolution.backend.health();
  if (typeof resolution.backend.search !== 'function') {
    throw new Error(`Selected backend ${resolution.selected_backend} does not support read/search`);
  }
  const memories = await resolution.backend.search(args.query, { limit: args.limit });
  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    query: args.query,
    limit: args.limit,
    backend: {
      requested_backend: resolution.requested_backend,
      selected_backend: resolution.selected_backend,
      selection_reason: resolution.selection_reason,
      kind: resolution.backend.kind,
      id: resolution.backend.id,
      display_name: resolution.backend.display_name,
      capabilities: resolution.backend.capabilities,
      config_summary: resolution.backend.config_summary,
      health
    },
    memory_count: memories.length,
    memories
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive memory retrieval (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`read_only: yes`);
  lines.push(`selected_backend: ${report.backend.selected_backend}`);
  lines.push(`query: ${report.query}`);
  lines.push(`memories: ${report.memory_count}`);
  for (const memory of report.memories) {
    lines.push(`- ${memory.memory_id ?? 'unknown'} ${memory.category ?? 'other'} score=${memory.score ?? 'n/a'} ${String(memory.content ?? '').slice(0, 180)}`);
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await retrieveMemories(args);
    if (args.format === 'json') console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(formatText(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
