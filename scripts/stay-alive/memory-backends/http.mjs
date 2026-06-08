function authHeaders(config) {
  const headers = { 'content-type': 'application/json' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return headers;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  if (!response.ok) {
    throw new Error(`HTTP memory backend failed: HTTP ${response.status} ${text.slice(0, 240)}`);
  }
  return data ?? {};
}

function normalizeRows(data, limit) {
  const rows = Array.isArray(data)
    ? data
    : data.memories ?? data.results ?? data.items ?? data.data ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limit).map((row, index) => ({
    memory_id: row.id ?? row.memory_id ?? row.memoryId ?? null,
    score: row.score ?? row.similarity ?? row.relevance ?? null,
    content: row.content ?? row.text ?? row.memory ?? '',
    category: row.category ?? row.metadata?.category ?? null,
    memory_type: row.memory_type ?? row.memoryType ?? row.metadata?.memory_type ?? null,
    created_at: row.created_at ?? row.createdAt ?? row.metadata?.created_at ?? null,
    source: row.source ?? row.metadata?.source ?? null,
    backend_kind: 'http',
    rank: index + 1
  }));
}

export function createHttpMemoryBackend(config) {
  const baseUrl = String(config.base_url ?? '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('HTTP memory backend requires --memory-http-url or STAY_ALIVE_MEMORY_HTTP_URL');
  const writePath = config.write_path ?? '/memories';
  const searchPath = config.search_path ?? '/memories/search';

  return {
    kind: 'http',
    id: config.backend_id ?? baseUrl,
    display_name: 'HTTP Memory API',
    capabilities: {
      write: true,
      vector_search: true,
      metadata_filter: true,
      update: false,
      delete: false,
      namespace: true,
      http: true
    },
    config_summary: {
      base_url: baseUrl,
      write_path: writePath,
      search_path: searchPath,
      token_configured: Boolean(config.token)
    },
    async write(event) {
      const data = await fetchJson(`${baseUrl}${writePath}`, {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({ event })
      });
      return {
        ok: true,
        backend_kind: 'http',
        backend_id: this.id,
        memory_id: data.id ?? data.memory_id ?? data.memoryId ?? event.dedupe_key,
        response: data
      };
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      const data = await fetchJson(`${baseUrl}${searchPath}`, {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          query,
          limit,
          scope: options.scope ?? null
        })
      });
      return normalizeRows(data, limit);
    },
    health() {
      return {
        ok: true,
        backend_kind: 'http',
        backend_id: this.id,
        base_url: baseUrl,
        token_configured: Boolean(config.token),
        probe: 'not_executed'
      };
    }
  };
}
