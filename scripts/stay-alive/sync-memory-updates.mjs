#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  canonicalMemoryEvent,
  categoryForPayload,
  textForMemoryUpdate
} from './memory-backends/contract.mjs';
import { resolveMemoryBackend } from './memory-backends/resolver.mjs';

const WORKSPACE = process.cwd();
const DEFAULT_RUNTIME = path.join(WORKSPACE, 'runtime', 'stay-alive', 'agents');
const DEFAULT_LIMIT = 200;

function parseArgs(argv) {
  const args = {
    agent: 'badclaw',
    runtimeRoot: DEFAULT_RUNTIME,
    limit: DEFAULT_LIMIT,
    format: 'text',
    dryRun: true,
    confirmSync: null,
    backend: 'auto',
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
    memoryBackendTimeoutMs: null,
    ledgerDir: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--runtime-root') args.runtimeRoot = path.resolve(argv[++i]);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--backend') args.backend = argv[++i];
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
    else if (arg === '--ledger-dir') args.ledgerDir = path.resolve(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--confirm-sync') {
      args.confirmSync = argv[++i];
      args.dryRun = false;
    } else if (arg === '--json') args.format = 'json';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  if (args.memoryBackendTimeoutMs !== null && (!Number.isInteger(args.memoryBackendTimeoutMs) || args.memoryBackendTimeoutMs < 1000)) {
    throw new Error('--memory-backend-timeout-ms must be an integer >= 1000');
  }
  if (!args.dryRun && args.confirmSync !== 'SYNC_MEMORY') {
    throw new Error('Writing to a memory backend requires --confirm-sync SYNC_MEMORY');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/stay-alive/sync-memory-updates.mjs [options]

Sync applied Stay-Alive memory proposals from local memory_updates/*.json into
the best available memory backend. The command is local-only and does not call
BotLand or any external social surface.

Options:
  --agent <id>                 Agent id. Default: badclaw
  --runtime-root <dir>         Runtime agents directory
  --limit <n>                  Max local memory update files to inspect
  --backend <auto|lancedb|json-local|memory-pro-cli|mcp|http|sqlite|pgvector>
                               Memory backend selection. Default: auto
  --lancedb-path <dir>         Override LanceDB database path
  --json-store-dir <dir>       Override local JSON fallback backend directory
  --memory-pro-command <cmd>   Override memory-pro CLI command. Default:
                               "openclaw memory-pro"
  --memory-http-url <url>      HTTP memory API base URL
  --memory-http-token <token>  HTTP memory API bearer token
  --memory-mcp-endpoint <url>  MCP JSON-RPC endpoint
  --memory-mcp-token <token>   MCP bearer token
  --memory-mcp-write-tool <name>
                               MCP write tool. Default: memory.add
  --memory-mcp-search-tool <name>
                               MCP search tool. Default: memory.search
  --sqlite-path <file>         SQLite backend file path
  --sqlite-table <name>        SQLite table name
  --pg-connection-string <dsn> PostgreSQL/pgvector connection string
  --pg-table <name>            PostgreSQL table name
  --psql-command <cmd>         psql executable. Default: psql
  --memory-backend-timeout-ms <n>
                               Driver command timeout
  --ledger-dir <dir>           Override local sync ledger dir
  --dry-run                    Plan only. Default
  --confirm-sync SYNC_MEMORY   Write to selected backend and local sync ledger
  --json                       Print JSON
  --help                       Show this help
`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function listJsonFiles(dir, limit) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => path.join(dir, name));
}

function buildPlan(args) {
  const agentDir = path.join(args.runtimeRoot, args.agent);
  const memoryDir = path.join(agentDir, 'memory_updates');
  const ledgerDir = args.ledgerDir ?? path.join(agentDir, 'memory_sync');
  const files = listJsonFiles(memoryDir, args.limit);
  const updates = files.map((file) => {
    const json = readJson(file);
    const hash = json.proposal_hash ?? path.basename(file, '.json');
    const ledgerPath = path.join(ledgerDir, `${hash}.json`);
    const relativeFile = path.relative(WORKSPACE, file);
    const text = textForMemoryUpdate(json);
    const category = categoryForPayload(json.payload);
    return {
      hash,
      file,
      relative_file: relativeFile,
      ledger_path: ledgerPath,
      relative_ledger_path: path.relative(WORKSPACE, ledgerPath),
      already_synced: existsSync(ledgerPath),
      item: json,
      text,
      category,
      event: canonicalMemoryEvent({
        agentId: args.agent,
        proposalHash: hash,
        sourceFile: relativeFile,
        item: json,
        text,
        category
      })
    };
  }).filter((item) => item.text.length > 0);
  return {
    agent_dir: agentDir,
    memory_dir: memoryDir,
    ledger_dir: ledgerDir,
    updates,
    pending: updates.filter((item) => !item.already_synced)
  };
}

async function syncPending(args, backendResolution, pending) {
  const synced = [];
  const backend = backendResolution.backend;
  for (const item of pending) {
    const result = await backend.write(item.event);
    const ledger = {
      synced_at: new Date().toISOString(),
      agent_id: args.agent,
      source: 'stay_alive_memory_update',
      memory_backend: backend.kind,
      memory_backend_id: backend.id,
      memory_backend_display_name: backend.display_name,
      backend_capabilities: backend.capabilities,
      backend_selection: {
        requested_backend: backendResolution.requested_backend,
        selected_backend: backendResolution.selected_backend,
        selection_reason: backendResolution.selection_reason
      },
      backend_result: result,
      memory_id: result.memory_id,
      proposal_hash: item.hash,
      source_file: item.relative_file,
      category: item.category,
      text: item.text,
      canonical_event: item.event,
      local_only: true,
      external_write: false
    };
    writeJson(item.ledger_path, ledger);
    synced.push({
      proposal_hash: item.hash,
      memory_id: result.memory_id,
      ledger_path: item.relative_ledger_path,
      backend_kind: backend.kind,
      backend_id: backend.id,
      category: item.category
    });
  }
  return synced;
}

function formatText(report) {
  const lines = [];
  lines.push(`Stay-Alive memory sync (${report.agent_id})`);
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`dry_run: ${report.dry_run ? 'yes' : 'no'}`);
  lines.push(`requested_backend: ${report.backend.requested_backend}`);
  lines.push(`selected_backend: ${report.backend.selected_backend}`);
  lines.push(`selection_reason: ${report.backend.selection_reason}`);
  lines.push(`backend_id: ${report.backend.id}`);
  if (report.backend.config_summary?.db_path) lines.push(`lancedb_path: ${report.backend.config_summary.db_path}`);
  if (report.backend.config_summary?.store_dir) lines.push(`json_store_dir: ${report.backend.config_summary.store_dir}`);
  lines.push(`inspected_updates: ${report.inspected_update_count}`);
  lines.push(`already_synced: ${report.already_synced_count}`);
  lines.push(`pending_sync: ${report.pending_sync_count}`);
  lines.push(`synced_now: ${report.synced_now_count}`);
  if (report.pending_preview.length > 0) {
    lines.push('pending_preview:');
    for (const item of report.pending_preview) {
      lines.push(`- ${item.proposal_hash} ${item.category}: ${item.text_preview}`);
    }
  }
  return lines.join('\n');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const plan = buildPlan(args);
  const backendResolution = resolveMemoryBackend(args, plan);
  const backendHealth = backendResolution.backend.health();
  const synced = args.dryRun ? [] : await syncPending(args, backendResolution, plan.pending);
  const report = {
    generated_at: generatedAt,
    agent_id: args.agent,
    runtime_root: args.runtimeRoot,
    dry_run: args.dryRun,
    local_only: true,
    external_write: false,
    backend: {
      requested_backend: backendResolution.requested_backend,
      selected_backend: backendResolution.selected_backend,
      selection_reason: backendResolution.selection_reason,
      kind: backendResolution.backend.kind,
      id: backendResolution.backend.id,
      display_name: backendResolution.backend.display_name,
      capabilities: backendResolution.backend.capabilities,
      config_summary: backendResolution.backend.config_summary,
      health: backendHealth
    },
    inspected_update_count: plan.updates.length,
    already_synced_count: plan.updates.filter((item) => item.already_synced).length,
    pending_sync_count: plan.pending.length,
    synced_now_count: synced.length,
    synced,
    pending_preview: plan.pending.slice(0, 10).map((item) => ({
      proposal_hash: item.hash,
      source_file: item.relative_file,
      category: item.category,
      memory_type: item.event.memory_type,
      dedupe_key: item.event.dedupe_key,
      text_preview: item.text.slice(0, 220)
    }))
  };
  console.log(args.format === 'json' ? JSON.stringify(report, null, 2) : formatText(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
