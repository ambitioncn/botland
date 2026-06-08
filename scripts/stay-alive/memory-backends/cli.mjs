import { spawnSync } from 'node:child_process';

function parseCommand(value, fallback) {
  if (Array.isArray(value) && value.length > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    return value.trim().split(/\s+/);
  }
  return fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30000,
    env: options.env ?? process.env
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${stderr || stdout || 'no output'}`);
  }
  return { stdout, stderr, status: result.status };
}

function safeJson(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeCliSearchRows(data, query, limit) {
  const rows = Array.isArray(data)
    ? data
    : data?.memories ?? data?.results ?? data?.items ?? data?.data ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limit).map((row, index) => ({
    memory_id: row.id ?? row.memory_id ?? row.memoryId ?? row.key ?? null,
    score: row.score ?? row.similarity ?? row.relevance ?? null,
    content: row.content ?? row.text ?? row.memory ?? row.value ?? '',
    category: row.category ?? row.metadata?.category ?? null,
    memory_type: row.memory_type ?? row.memoryType ?? row.metadata?.memory_type ?? null,
    created_at: row.created_at ?? row.createdAt ?? row.metadata?.created_at ?? null,
    source: row.source ?? row.metadata?.source ?? null,
    backend_kind: 'memory-pro-cli',
    rank: index + 1,
    query
  }));
}

export function createMemoryProCliBackend(config = {}) {
  const baseCommand = parseCommand(config.command, ['openclaw', 'memory-pro']);
  const executable = baseCommand[0];
  const prefixArgs = baseCommand.slice(1);
  const timeoutMs = config.timeout_ms ?? 30000;

  return {
    kind: 'memory-pro-cli',
    id: config.backend_id ?? 'memory-pro-cli',
    display_name: 'OpenClaw memory-pro CLI',
    capabilities: {
      write: true,
      vector_search: true,
      metadata_filter: true,
      update: false,
      delete: false,
      namespace: true,
      cli: true
    },
    config_summary: {
      command: baseCommand.join(' '),
      add_mode: 'stdin_json',
      search_mode: 'json'
    },
    async write(event) {
      const metadata = {
        schema: event.schema,
        agent_id: event.agent_id,
        memory_type: event.memory_type,
        category: event.category,
        importance: event.importance,
        source: event.source,
        tags: event.tags,
        relations: event.relations,
        dedupe_key: event.dedupe_key,
        created_at: event.created_at,
        local_only: true,
        external_write: false
      };
      const args = [
        ...prefixArgs,
        'add',
        '--scope',
        event.scope,
        '--text',
        event.content,
        '--metadata-json',
        JSON.stringify(metadata),
        '--json'
      ];
      const result = run(executable, args, { timeoutMs });
      const data = safeJson(result.stdout, {});
      return {
        ok: true,
        backend_kind: 'memory-pro-cli',
        backend_id: this.id,
        memory_id: data.id ?? data.memory_id ?? data.memoryId ?? event.dedupe_key,
        stdout_json: data,
        command: `${executable} ${args.slice(0, 3).join(' ')} ...`
      };
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      const scope = options.scope ?? config.scope ?? null;
      const args = [
        ...prefixArgs,
        'search',
        query,
        '--limit',
        String(limit),
        '--json'
      ];
      if (scope) args.splice(prefixArgs.length + 2, 0, '--scope', scope);
      const result = run(executable, args, { timeoutMs });
      const data = safeJson(result.stdout, []);
      return normalizeCliSearchRows(data, query, limit);
    },
    health() {
      return {
        ok: true,
        backend_kind: 'memory-pro-cli',
        backend_id: this.id,
        command: baseCommand.join(' '),
        probe: 'not_executed'
      };
    }
  };
}
