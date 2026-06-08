export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function categoryForPayload(payload) {
  if (payload?.type?.includes('decision')) return 'decision';
  if (payload?.type?.includes('relationship')) return 'entity';
  if (payload?.type?.includes('preference')) return 'preference';
  if (payload?.type?.includes('summary') || payload?.type?.includes('continuity')) return 'fact';
  return 'other';
}

export function textForMemoryUpdate(item) {
  const payload = item.payload ?? {};
  const parts = [
    `[stay-alive:${item.agent_id ?? 'agent'}]`,
    payload.type ? `type=${payload.type}` : null,
    payload.text ?? payload.value ?? null
  ].filter(Boolean);
  return normalizeText(parts.join(' '));
}

export function canonicalMemoryEvent({ agentId, proposalHash, sourceFile, item, text, category }) {
  const payload = item.payload ?? {};
  const createdAt = item.applied_at ?? item.created_at ?? item.generated_at ?? new Date().toISOString();
  return {
    schema: 'stay_alive.memory_event.v1',
    agent_id: agentId,
    scope: item.scope ?? `agent:${agentId}`,
    content: text,
    memory_type: payload.type ?? item.type ?? 'stay_alive_memory_update',
    category,
    importance: payload.importance ?? item.importance ?? 0.7,
    source: {
      kind: 'stay_alive_memory_update',
      proposal_hash: proposalHash,
      source_file: sourceFile,
      run_id: item.run_id ?? item.source_run_id ?? null,
      proposal_id: item.proposal_id ?? null
    },
    tags: [
      'stay-alive',
      category,
      payload.type ?? null
    ].filter(Boolean),
    relations: item.relations ?? payload.relations ?? [],
    dedupe_key: `stay-alive:${agentId}:${proposalHash}`,
    created_at: createdAt,
    local_only: true,
    external_write: false,
    raw_payload: payload
  };
}
