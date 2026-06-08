function headers(config) {
  const result = { 'content-type': 'application/json' };
  if (config.token) result.authorization = `Bearer ${config.token}`;
  return result;
}

async function callMcpTool(config, toolName, args) {
  const endpoint = String(config.endpoint ?? '').replace(/\/$/, '');
  if (!endpoint) throw new Error('MCP memory backend requires --memory-mcp-endpoint or STAY_ALIVE_MEMORY_MCP_ENDPOINT');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `stay-alive-${Date.now()}`,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    })
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) throw new Error(`MCP memory backend HTTP ${response.status}: ${text.slice(0, 240)}`);
  if (data?.error) throw new Error(`MCP memory backend error: ${JSON.stringify(data.error).slice(0, 400)}`);
  return data?.result ?? data ?? {};
}

function contentToJson(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return result;
  const textBlock = content.find((item) => item?.type === 'text' && typeof item.text === 'string');
  if (!textBlock) return result;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { text: textBlock.text };
  }
}

function normalizeRows(result, limit) {
  const data = contentToJson(result);
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
    backend_kind: 'mcp',
    rank: index + 1
  }));
}

export function createMcpMemoryBackend(config) {
  const endpoint = config.endpoint ?? null;
  const writeTool = config.write_tool ?? 'memory.add';
  const searchTool = config.search_tool ?? 'memory.search';

  return {
    kind: 'mcp',
    id: config.backend_id ?? endpoint ?? 'mcp-memory',
    display_name: 'MCP Memory Server',
    capabilities: {
      write: true,
      vector_search: true,
      metadata_filter: true,
      update: false,
      delete: false,
      namespace: true,
      mcp: true
    },
    config_summary: {
      endpoint,
      write_tool: writeTool,
      search_tool: searchTool,
      token_configured: Boolean(config.token)
    },
    async write(event) {
      const result = await callMcpTool(config, writeTool, { event });
      const data = contentToJson(result);
      return {
        ok: true,
        backend_kind: 'mcp',
        backend_id: this.id,
        memory_id: data.id ?? data.memory_id ?? data.memoryId ?? event.dedupe_key,
        response: data
      };
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      const result = await callMcpTool(config, searchTool, {
        query,
        limit,
        scope: options.scope ?? null
      });
      return normalizeRows(result, limit);
    },
    health() {
      return {
        ok: true,
        backend_kind: 'mcp',
        backend_id: this.id,
        endpoint,
        write_tool: writeTool,
        search_tool: searchTool,
        probe: 'not_executed'
      };
    }
  };
}
