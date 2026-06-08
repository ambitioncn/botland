import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const TABLE_NAME = 'memories';

async function embedWithOllama(text, embedding) {
  const baseUrl = embedding.base_url ?? 'http://127.0.0.1:11434';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: embedding.model,
      input: text
    })
  });
  if (!response.ok) throw new Error(`Ollama embedding failed: HTTP ${response.status}`);
  const data = await response.json();
  const vector = data.embeddings?.[0] ?? data.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('Ollama embedding response did not include a vector');
  if (embedding.dimensions && vector.length !== embedding.dimensions) {
    throw new Error(`Embedding dimension mismatch: got ${vector.length}, expected ${embedding.dimensions}`);
  }
  return vector;
}

async function loadLanceDb() {
  const modulePath = path.join(
    homedir(),
    '.openclaw',
    'extensions',
    'memory-lancedb',
    'node_modules',
    '@lancedb',
    'lancedb',
    'dist',
    'index.js'
  );
  return import(modulePath);
}

async function openMemoryTable(dbPath, vectorDim) {
  const lancedb = await loadLanceDb();
  const db = await lancedb.connect(dbPath);
  if ((await db.tableNames()).includes(TABLE_NAME)) return db.openTable(TABLE_NAME);
  const table = await db.createTable(TABLE_NAME, [{
    id: '__schema__',
    text: '',
    vector: Array.from({ length: vectorDim }).fill(0),
    source: 'stay-alive',
    path: '',
    model: 'stay-alive',
    start_line: 0,
    end_line: 0,
    updated_at: 0
  }]);
  await table.delete('id = "__schema__"');
  return table;
}

async function openExistingMemoryTable(dbPath) {
  const lancedb = await loadLanceDb();
  const db = await lancedb.connect(dbPath);
  if (!(await db.tableNames()).includes(TABLE_NAME)) return null;
  return db.openTable(TABLE_NAME);
}

function numericValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function timestampIso(value) {
  const numeric = numericValue(value);
  if (numeric === null || !Number.isFinite(numeric)) return null;
  return new Date(numeric).toISOString();
}

export function createLanceDbBackend(config) {
  return {
    kind: 'lancedb',
    id: config.openclaw_memory?.plugin_id ?? 'memory-lancedb',
    display_name: 'OpenClaw memory-lancedb',
    capabilities: {
      write: true,
      vector_search: true,
      metadata_filter: false,
      update: false,
      delete: false,
      namespace: false
    },
    config_summary: {
      db_path: config.db_path,
      embedding: config.embedding,
      openclaw_memory: config.openclaw_memory
    },
    async write(event) {
      const vector = await embedWithOllama(event.content, config.embedding);
      const table = await openMemoryTable(config.db_path, vector.length);
      const memoryId = randomUUID();
      await table.add([{
        id: memoryId,
        text: event.content,
        vector,
        source: event.source?.kind ?? 'stay_alive_memory_update',
        path: event.source?.source_file ?? event.dedupe_key ?? '',
        model: event.memory_type ?? 'stay_alive_memory_update',
        start_line: 0,
        end_line: 0,
        updated_at: Date.now()
      }]);
      return {
        ok: true,
        backend_kind: 'lancedb',
        backend_id: this.id,
        memory_id: memoryId,
        lancedb_path: config.db_path
      };
    },
    async search(query, options = {}) {
      const vector = await embedWithOllama(query, config.embedding);
      const table = await openExistingMemoryTable(config.db_path);
      if (!table) return [];
      const rows = await table.search(vector).limit(options.limit ?? 5).toArray();
      return rows.map((row) => {
        const distance = numericValue(row._distance);
        return {
          memory_id: row.id ?? null,
          score: distance !== null ? 1 / (1 + distance) : null,
          distance,
          content: row.text ?? '',
          category: row.category ?? null,
          memory_type: row.memory_type ?? null,
          created_at: timestampIso(row.createdAt) ?? timestampIso(row.updated_at),
          source: row.source ?? null,
          backend_kind: 'lancedb'
        };
      });
    },
    health() {
      return {
        ok: true,
        backend_kind: 'lancedb',
        backend_id: this.id,
        db_path: config.db_path,
        plugin_enabled: config.openclaw_memory?.plugin_enabled === true
      };
    }
  };
}
