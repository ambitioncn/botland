import { spawnSync } from 'node:child_process';

function runPsql(config, sql) {
  const args = ['-X', '-q', '-t', '-A', '-F', '\t'];
  if (config.connection_string) args.push(config.connection_string);
  args.push('-c', sql);
  const result = spawnSync(config.psql_command ?? 'psql', args, {
    encoding: 'utf8',
    timeout: config.timeout_ms ?? 30000,
    env: process.env
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(`psql failed (${result.status}): ${stderr || stdout || 'no output'}`);
  }
  return stdout;
}

function sqlString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function ensureTable(config) {
  const table = config.table_name;
  runPsql(config, `
CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT,
  category TEXT,
  importance DOUBLE PRECISION,
  tags JSONB,
  source JSONB,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${table}_agent_scope ON ${table}(agent_id, scope);
`);
}

function parseRows(text) {
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line) => {
    const [id, content, category, memoryType, createdAt, sourceJson] = line.split('\t');
    return {
      id,
      content,
      category,
      memory_type: memoryType,
      created_at: createdAt,
      source: sourceJson ? JSON.parse(sourceJson) : null
    };
  });
}

export function createPgvectorMemoryBackend(config) {
  const tableName = config.table_name ?? 'stay_alive_memories';
  if (!config.connection_string && !process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('pgvector memory backend requires --pg-connection-string, DATABASE_URL, or PG* environment');
  }
  const normalized = {
    ...config,
    connection_string: config.connection_string ?? process.env.DATABASE_URL ?? null,
    table_name: tableName
  };

  return {
    kind: 'pgvector',
    id: config.backend_id ?? tableName,
    display_name: 'PostgreSQL/pgvector Memory Store',
    capabilities: {
      write: true,
      vector_search: false,
      metadata_filter: true,
      update: true,
      delete: false,
      namespace: true,
      sql: true,
      pgvector_ready: true
    },
    config_summary: {
      table_name: tableName,
      connection_configured: Boolean(normalized.connection_string || process.env.PGHOST || process.env.DATABASE_URL),
      requires_cli: normalized.psql_command ?? 'psql',
      note: 'stores canonical events now; vector column can be added without changing Memory Contract'
    },
    async write(event) {
      ensureTable(normalized);
      runPsql(normalized, `
INSERT INTO ${tableName}
(id, agent_id, scope, content, memory_type, category, importance, tags, source, event, created_at)
VALUES (
  ${sqlString(event.dedupe_key)},
  ${sqlString(event.agent_id)},
  ${sqlString(event.scope)},
  ${sqlString(event.content)},
  ${sqlString(event.memory_type)},
  ${sqlString(event.category)},
  ${Number(event.importance ?? 0)},
  ${sqlString(JSON.stringify(event.tags ?? []))}::jsonb,
  ${sqlString(JSON.stringify(event.source ?? {}))}::jsonb,
  ${sqlString(JSON.stringify(event))}::jsonb,
  ${sqlString(event.created_at)}::timestamptz
)
ON CONFLICT (id) DO UPDATE SET
  content = EXCLUDED.content,
  memory_type = EXCLUDED.memory_type,
  category = EXCLUDED.category,
  importance = EXCLUDED.importance,
  tags = EXCLUDED.tags,
  source = EXCLUDED.source,
  event = EXCLUDED.event,
  created_at = EXCLUDED.created_at;
`);
      return {
        ok: true,
        backend_kind: 'pgvector',
        backend_id: this.id,
        memory_id: event.dedupe_key,
        table_name: tableName
      };
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      ensureTable(normalized);
      const rows = parseRows(runPsql(normalized, `
SELECT id, content, category, memory_type, created_at::text, source::text
FROM ${tableName}
WHERE content ILIKE ${sqlString(`%${query}%`)}
   OR memory_type ILIKE ${sqlString(`%${query}%`)}
   OR category ILIKE ${sqlString(`%${query}%`)}
ORDER BY created_at DESC
LIMIT ${Number(limit)};
`));
      return rows.map((row, index) => ({
        memory_id: row.id,
        score: null,
        content: row.content ?? '',
        category: row.category ?? null,
        memory_type: row.memory_type ?? null,
        created_at: row.created_at ?? null,
        source: row.source,
        backend_kind: 'pgvector',
        rank: index + 1
      }));
    },
    health() {
      return {
        ok: true,
        backend_kind: 'pgvector',
        backend_id: this.id,
        table_name: tableName,
        probe: 'not_executed'
      };
    }
  };
}
