import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreText(query, text) {
  const normalizedQuery = normalize(query);
  const normalizedText = normalize(text);
  if (!normalizedQuery || !normalizedText) return 0;
  const terms = Array.from(new Set(normalizedQuery.split(/\s+/).filter((term) => term.length >= 2)));
  if (terms.length === 0) return 0;
  const hits = terms.filter((term) => normalizedText.includes(term)).length;
  return hits / terms.length;
}

export function createJsonLocalBackend(config) {
  return {
    kind: 'json-local',
    id: 'json-local',
    display_name: 'Local JSON memory event store',
    capabilities: {
      write: true,
      vector_search: false,
      metadata_filter: true,
      update: false,
      delete: false,
      namespace: true
    },
    config_summary: {
      store_dir: config.store_dir
    },
    async write(event) {
      mkdirSync(config.store_dir, { recursive: true });
      const file = path.join(config.store_dir, `${event.source.proposal_hash}.json`);
      writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`);
      return {
        ok: true,
        backend_kind: 'json-local',
        backend_id: 'json-local',
        memory_id: event.dedupe_key,
        store_file: file
      };
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      if (!existsSync(config.store_dir)) return [];
      return readdirSync(config.store_dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const file = path.join(config.store_dir, name);
          const event = JSON.parse(readFileSync(file, 'utf8'));
          const score = scoreText(query, [
            event.content,
            event.memory_type,
            event.category,
            ...(Array.isArray(event.tags) ? event.tags : [])
          ].filter(Boolean).join(' '));
          return {
            memory_id: event.dedupe_key ?? path.basename(name, '.json'),
            score,
            content: event.content ?? '',
            category: event.category ?? null,
            memory_type: event.memory_type ?? null,
            created_at: event.created_at ?? null,
            source: event.source ?? null,
            backend_kind: 'json-local'
          };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
        .slice(0, limit);
    },
    health() {
      return {
        ok: true,
        backend_kind: 'json-local',
        backend_id: 'json-local',
        store_dir: config.store_dir
      };
    }
  };
}
