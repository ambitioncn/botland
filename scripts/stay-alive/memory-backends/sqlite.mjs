import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function runSqlite(dbPath, sql, timeoutMs = 30000) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed (${result.status}): ${stderr || stdout || 'no output'}`);
  }
  if (!stdout) return [];
  try {
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

function sqlString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function ensureTable(dbPath, tableName, timeoutMs) {
  runSqlite(dbPath, `
CREATE TABLE IF NOT EXISTS ${tableName} (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT,
  category TEXT,
  importance REAL,
  tags_json TEXT,
  source_json TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${tableName}_agent_scope ON ${tableName}(agent_id, scope);
CREATE INDEX IF NOT EXISTS idx_${tableName}_category ON ${tableName}(category);
`, timeoutMs);
}

export function createSqliteMemoryBackend(config) {
  const dbPath = config.db_path;
  const tableName = config.table_name ?? 'stay_alive_memories';
  const timeoutMs = config.timeout_ms ?? 30000;
  if (!dbPath) throw new Error('SQLite memory backend requires --sqlite-path or STAY_ALIVE_MEMORY_SQLITE_PATH');

  return {
    kind: 'sqlite',
    id: config.backend_id ?? dbPath,
    display_name: 'SQLite Memory Store',
    capabilities: {
      write: true,
      vector_search: false,
      metadata_filter: true,
      update: true,
      delete: false,
      namespace: true,
      sql: true
    },
    config_summary: {
      db_path: dbPath,
      table_name: tableName,
      requires_cli: 'sqlite3'
    },
    async write(event) {
      ensureTable(dbPath, tableName, timeoutMs);
      runSqlite(dbPath, `
INSERT OR REPLACE INTO ${tableName}
(id, agent_id, scope, content, memory_type, category, importance, tags_json, source_json, event_json, created_at)
VALUES (
  ${sqlString(event.dedupe_key)},
  ${sqlString(event.agent_id)},
  ${sqlString(event.scope)},
  ${sqlString(event.content)},
  ${sqlString(event.memory_type)},
  ${sqlString(event.category)},
  ${Number(event.importance ?? 0)},
  ${sqlString(JSON.stringify(event.tags ?? []))},
  ${sqlString(JSON.stringify(event.source ?? {}))},
  ${sqlString(JSON.stringify(event))},
  ${sqlString(event.created_at)}
);
`, timeoutMs);
      return {
        ok: true,
        backend_kind: 'sqlite',
        backend_id: this.id,
        memory_id: event.dedupe_key,
        sqlite_path: dbPath,
        table_name: tableName
      };
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      if (!existsSync(dbPath)) return [];
      ensureTable(dbPath, tableName, timeoutMs);
      const pattern = `%${String(query ?? '').replace(/[%_]/g, '')}%`;
      const rows = runSqlite(dbPath, `
SELECT id, content, category, memory_type, created_at, source_json
FROM ${tableName}
WHERE content LIKE ${sqlString(pattern)}
   OR memory_type LIKE ${sqlString(pattern)}
   OR category LIKE ${sqlString(pattern)}
ORDER BY created_at DESC
LIMIT ${Number(limit)};
`, timeoutMs);
      return rows.map((row, index) => ({
        memory_id: row.id,
        score: null,
        content: row.content ?? '',
        category: row.category ?? null,
        memory_type: row.memory_type ?? null,
        created_at: row.created_at ?? null,
        source: row.source_json ? JSON.parse(row.source_json) : null,
        backend_kind: 'sqlite',
        rank: index + 1
      }));
    },
    health() {
      return {
        ok: true,
        backend_kind: 'sqlite',
        backend_id: this.id,
        db_path: dbPath,
        table_name: tableName,
        probe: 'not_executed'
      };
    }
  };
}
