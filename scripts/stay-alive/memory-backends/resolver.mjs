import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { createMemoryProCliBackend } from './cli.mjs';
import { createHttpMemoryBackend } from './http.mjs';
import { createJsonLocalBackend } from './json-local.mjs';
import { createLanceDbBackend } from './lancedb.mjs';
import { createMcpMemoryBackend } from './mcp.mjs';
import { createPgvectorMemoryBackend } from './pgvector.mjs';
import { createSqliteMemoryBackend } from './sqlite.mjs';

function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadOpenClawMemoryConfig() {
  const configPath = path.join(homedir(), '.openclaw', 'openclaw.json');
  const config = readJsonIfExists(configPath, {});
  const entries = config.plugins?.entries ?? {};
  const memorySlot = config.plugins?.slots?.memory ?? null;
  const preferredId = memorySlot && entries[memorySlot] ? memorySlot : entries['memory-lancedb'] ? 'memory-lancedb' : null;
  const entry = preferredId ? entries[preferredId] : null;
  return {
    config_path: configPath,
    plugin_id: preferredId,
    plugin_enabled: entry?.enabled === true,
    plugin_config: entry?.config ?? null
  };
}

export function resolveMemoryBackend(args, plan) {
  const requested = args.backend ?? process.env.STAY_ALIVE_MEMORY_BACKEND ?? 'auto';
  const openclawMemory = loadOpenClawMemoryConfig();
  const pluginConfig = openclawMemory.plugin_config ?? {};
  const embedding = pluginConfig.embedding ?? {};
  const lancedbConfig = {
    openclaw_memory: {
      plugin_id: openclawMemory.plugin_id,
      plugin_enabled: openclawMemory.plugin_enabled,
      config_path: openclawMemory.config_path
    },
    db_path: args.lancedbPath
      ?? pluginConfig.dbPath
      ?? path.join(homedir(), '.openclaw', 'memory', 'lancedb'),
    embedding: {
      provider: embedding.provider ?? 'openai',
      model: embedding.model ?? 'text-embedding-3-small',
      base_url: embedding.baseUrl ?? null,
      dimensions: embedding.dimensions ?? null
    }
  };

  const jsonConfig = {
    store_dir: args.jsonStoreDir ?? path.join(plan.agent_dir, 'memory_backend_json')
  };
  const memoryProCliConfig = {
    command: args.memoryProCommand ?? process.env.STAY_ALIVE_MEMORY_PRO_COMMAND ?? 'openclaw memory-pro',
    timeout_ms: args.memoryBackendTimeoutMs
  };
  const httpConfig = {
    base_url: args.memoryHttpUrl ?? process.env.STAY_ALIVE_MEMORY_HTTP_URL ?? null,
    token: args.memoryHttpToken ?? process.env.STAY_ALIVE_MEMORY_HTTP_TOKEN ?? null,
    write_path: args.memoryHttpWritePath ?? process.env.STAY_ALIVE_MEMORY_HTTP_WRITE_PATH ?? '/memories',
    search_path: args.memoryHttpSearchPath ?? process.env.STAY_ALIVE_MEMORY_HTTP_SEARCH_PATH ?? '/memories/search'
  };
  const mcpConfig = {
    endpoint: args.memoryMcpEndpoint ?? process.env.STAY_ALIVE_MEMORY_MCP_ENDPOINT ?? null,
    token: args.memoryMcpToken ?? process.env.STAY_ALIVE_MEMORY_MCP_TOKEN ?? null,
    write_tool: args.memoryMcpWriteTool ?? process.env.STAY_ALIVE_MEMORY_MCP_WRITE_TOOL ?? 'memory.add',
    search_tool: args.memoryMcpSearchTool ?? process.env.STAY_ALIVE_MEMORY_MCP_SEARCH_TOOL ?? 'memory.search'
  };
  const sqliteConfig = {
    db_path: args.sqlitePath ?? process.env.STAY_ALIVE_MEMORY_SQLITE_PATH ?? path.join(plan.agent_dir, 'memory_backend_sqlite', 'memories.sqlite3'),
    table_name: args.sqliteTable ?? process.env.STAY_ALIVE_MEMORY_SQLITE_TABLE ?? 'stay_alive_memories',
    timeout_ms: args.memoryBackendTimeoutMs
  };
  const pgvectorConfig = {
    connection_string: args.pgConnectionString ?? process.env.STAY_ALIVE_MEMORY_PG_CONNECTION_STRING ?? process.env.DATABASE_URL ?? null,
    table_name: args.pgTable ?? process.env.STAY_ALIVE_MEMORY_PG_TABLE ?? 'stay_alive_memories',
    psql_command: args.psqlCommand ?? process.env.STAY_ALIVE_MEMORY_PSQL_COMMAND ?? 'psql',
    timeout_ms: args.memoryBackendTimeoutMs
  };

  if (requested === 'lancedb') {
    return {
      requested_backend: requested,
      selected_backend: 'lancedb',
      selection_reason: 'explicit_backend',
      backend: createLanceDbBackend(lancedbConfig)
    };
  }

  if (requested === 'json-local' || requested === 'json') {
    return {
      requested_backend: requested,
      selected_backend: 'json-local',
      selection_reason: 'explicit_backend',
      backend: createJsonLocalBackend(jsonConfig)
    };
  }

  if (requested === 'memory-pro' || requested === 'memory-pro-cli' || requested === 'cli') {
    return {
      requested_backend: requested,
      selected_backend: 'memory-pro-cli',
      selection_reason: 'explicit_backend',
      backend: createMemoryProCliBackend(memoryProCliConfig)
    };
  }

  if (requested === 'http' || requested === 'memory-http') {
    return {
      requested_backend: requested,
      selected_backend: 'http',
      selection_reason: 'explicit_backend',
      backend: createHttpMemoryBackend(httpConfig)
    };
  }

  if (requested === 'mcp' || requested === 'memory-mcp') {
    return {
      requested_backend: requested,
      selected_backend: 'mcp',
      selection_reason: 'explicit_backend',
      backend: createMcpMemoryBackend(mcpConfig)
    };
  }

  if (requested === 'sqlite') {
    return {
      requested_backend: requested,
      selected_backend: 'sqlite',
      selection_reason: 'explicit_backend',
      backend: createSqliteMemoryBackend(sqliteConfig)
    };
  }

  if (requested === 'pgvector' || requested === 'postgres' || requested === 'postgresql') {
    return {
      requested_backend: requested,
      selected_backend: 'pgvector',
      selection_reason: 'explicit_backend',
      backend: createPgvectorMemoryBackend(pgvectorConfig)
    };
  }

  if (requested !== 'auto') throw new Error(`Unknown memory backend: ${requested}`);

  if (openclawMemory.plugin_id === 'memory-lancedb-pro' && openclawMemory.plugin_enabled === true) {
    return {
      requested_backend: requested,
      selected_backend: 'memory-pro-cli',
      selection_reason: 'openclaw_memory_slot',
      backend: createMemoryProCliBackend(memoryProCliConfig)
    };
  }

  if (openclawMemory.plugin_id === 'memory-lancedb' && openclawMemory.plugin_enabled === true) {
    return {
      requested_backend: requested,
      selected_backend: 'lancedb',
      selection_reason: 'openclaw_memory_slot',
      backend: createLanceDbBackend(lancedbConfig)
    };
  }

  return {
    requested_backend: requested,
    selected_backend: 'json-local',
    selection_reason: 'fallback_no_supported_memory_slot',
    backend: createJsonLocalBackend(jsonConfig)
  };
}
