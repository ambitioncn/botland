function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sentenceClamp(text, maxLength = 420) {
  const clean = normalizeText(text);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function daysSince(value, now) {
  if (!isIsoDate(value)) return null;
  return Math.floor((now.getTime() - new Date(value).getTime()) / (24 * 60 * 60 * 1000));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ''));
}

function personNodeId(source, id, fallback) {
  const raw = id || fallback || source;
  return `person:${String(raw).toLowerCase()}`;
}

function communityNodeId(id, fallback) {
  return `community:${String(id || fallback || 'unknown').toLowerCase()}`;
}

function contentNodeId(kind, id, fallback) {
  return `${kind}:${String(id || fallback || 'unknown').toLowerCase()}`;
}

function mergeNode(nodes, node) {
  const existing = nodes.get(node.id);
  if (!existing) {
    nodes.set(node.id, {
      ...node,
      sources: Array.from(new Set(node.sources ?? [])),
      evidence: node.evidence ?? {}
    });
    return nodes.get(node.id);
  }

  existing.sources = Array.from(new Set([...(existing.sources ?? []), ...(node.sources ?? [])]));
  existing.label = existing.label ?? node.label;
  existing.kind = existing.kind ?? node.kind;
  existing.citizen_id = existing.citizen_id ?? node.citizen_id ?? null;
  existing.relationship = existing.relationship ?? node.relationship ?? null;
  existing.last_interaction_at = existing.last_interaction_at ?? node.last_interaction_at ?? null;
  existing.evidence = {
    ...(existing.evidence ?? {}),
    ...(node.evidence ?? {})
  };
  return existing;
}

function addEdge(edges, from, to, type, evidence = {}) {
  if (!from || !to) return;
  const id = `${from}->${type}->${to}`;
  const existing = edges.get(id);
  if (!existing) {
    edges.set(id, {
      id,
      from,
      to,
      type,
      weight: 1,
      evidence: compactObject(evidence)
    });
    return;
  }
  existing.weight += 1;
  existing.evidence = compactObject({
    ...(existing.evidence ?? {}),
    ...evidence
  });
}

function getKnownRelationshipKeySets(lifeState) {
  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  const ids = new Set();
  const names = new Set();
  for (const relationship of relationships) {
    for (const id of [relationship.target_id, relationship.botland_citizen_id, relationship.citizen_id]) {
      if (id) ids.add(String(id));
    }
    if (relationship.name) names.add(String(relationship.name).toLowerCase());
  }
  return { ids, names };
}

function knownRelationshipForPerson(person, keySets) {
  const name = person.display_name ?? person.name ?? person.label ?? null;
  return Boolean(
    (person.citizen_id && keySets.ids.has(String(person.citizen_id)))
      || (person.id && keySets.ids.has(String(person.id)))
      || (name && keySets.names.has(String(name).toLowerCase()))
  );
}

export function buildRelationshipGraph({
  lifeState,
  now,
  actor = {},
  friends = [],
  moments = [],
  communities = [],
  communityPosts = []
}) {
  const nodes = new Map();
  const edges = new Map();
  const gaps = [];
  const attention = [];
  const keySets = getKnownRelationshipKeySets(lifeState);
  const selfId = personNodeId('self', actor.actual_citizen_id ?? actor.expected_citizen_id ?? lifeState.botland?.citizen_id, lifeState.agent_id);

  mergeNode(nodes, {
    id: selfId,
    kind: 'agent',
    label: lifeState.self_model?.name ?? lifeState.botland?.display_name ?? lifeState.agent_id ?? 'agent',
    citizen_id: actor.actual_citizen_id ?? actor.expected_citizen_id ?? lifeState.botland?.citizen_id ?? null,
    sources: ['life_state', actor.actual_citizen_id ? 'botland_whoami' : null].filter(Boolean),
    evidence: {
      identity_match: actor.identity_match ?? null
    }
  });

  const relationships = Array.isArray(lifeState.relationships) ? lifeState.relationships : [];
  for (const relationship of relationships) {
    const nodeId = personNodeId('life_state', relationship.botland_citizen_id ?? relationship.citizen_id ?? relationship.target_id, relationship.name);
    const staleDays = daysSince(relationship.last_interaction_at, now);
    mergeNode(nodes, {
      id: nodeId,
      kind: 'person',
      label: relationship.name ?? relationship.target_id ?? nodeId,
      citizen_id: relationship.botland_citizen_id ?? relationship.citizen_id ?? null,
      relationship: relationship.relationship ?? null,
      last_interaction_at: relationship.last_interaction_at ?? null,
      sources: ['life_state'],
      evidence: {
        target_id: relationship.target_id ?? null,
        note_count: Array.isArray(relationship.notes) ? relationship.notes.length : 0,
        days_since_interaction: staleDays
      }
    });
    addEdge(edges, selfId, nodeId, relationship.relationship ?? 'knows', {
      source: 'life_state',
      last_interaction_at: relationship.last_interaction_at ?? null
    });
    if (staleDays === null || staleDays >= 14) {
      attention.push({
        severity: 'low',
        topic: 'relationship_continuity',
        node_id: nodeId,
        summary: `${relationship.name ?? relationship.target_id ?? 'A relationship'} has stale or missing interaction recency.`
      });
    }
    if (!relationship.botland_citizen_id && !relationship.citizen_id && relationship.target_id !== 'owner') {
      gaps.push({
        severity: 'low',
        type: 'relationship_missing_botland_id',
        node_id: nodeId,
        summary: `${relationship.name ?? relationship.target_id ?? 'Relationship'} has no BotLand citizen id binding.`
      });
    }
  }

  for (const friend of friends) {
    const nodeId = personNodeId('botland_friend', friend.citizen_id ?? friend.id, friend.display_name ?? friend.name);
    mergeNode(nodes, {
      id: nodeId,
      kind: 'person',
      label: friend.display_name ?? friend.name ?? friend.handle ?? friend.citizen_id ?? nodeId,
      citizen_id: friend.citizen_id ?? friend.id ?? null,
      sources: ['botland_friend'],
      evidence: {
        is_online: friend.is_online ?? null,
        my_label: friend.my_label ?? null,
        their_label: friend.their_label ?? null,
        species: friend.species ?? null
      }
    });
    addEdge(edges, selfId, nodeId, 'botland_friend', { source: 'friends_list' });
    if (!knownRelationshipForPerson(friend, keySets)) {
      gaps.push({
        severity: 'medium',
        type: 'friend_missing_life_state_relationship',
        node_id: nodeId,
        citizen_id: friend.citizen_id ?? friend.id ?? null,
        display_name: friend.display_name ?? friend.name ?? null,
        summary: `${friend.display_name ?? friend.name ?? friend.citizen_id ?? 'A BotLand friend'} is visible as a friend but not represented in life_state.relationships.`
      });
    }
  }

  for (const moment of moments) {
    const authorId = moment.author_id ?? moment.citizen_id ?? null;
    const authorNodeId = authorId
      ? personNodeId('moment_author', authorId, moment.display_name)
      : null;
    if (authorNodeId) {
      mergeNode(nodes, {
        id: authorNodeId,
        kind: 'person',
        label: moment.display_name ?? authorId,
        citizen_id: authorId,
        sources: ['public_moment_author'],
        evidence: {
          recent_public_moment_count: 1
        }
      });
    }
    const momentId = contentNodeId('moment', moment.moment_id ?? moment.id, moment.created_at);
    mergeNode(nodes, {
      id: momentId,
      kind: 'moment',
      label: sentenceClamp(moment.text_preview ?? moment.content ?? momentId, 80),
      sources: ['public_timeline'],
      evidence: {
        created_at: moment.created_at ?? null,
        visibility: moment.visibility ?? null,
        like_count: moment.like_count ?? null,
        comment_count: moment.comment_count ?? null,
        authored_by_self: moment.authored_by_self ?? null
      }
    });
    if (authorNodeId) {
      addEdge(edges, authorNodeId, momentId, 'authored_moment', {
        source: 'public_timeline',
        created_at: moment.created_at ?? null
      });
      if (!moment.authored_by_self && !knownRelationshipForPerson({ citizen_id: authorId, display_name: moment.display_name }, keySets)) {
        gaps.push({
          severity: 'low',
          type: 'public_author_missing_relationship',
          node_id: authorNodeId,
          citizen_id: authorId,
          display_name: moment.display_name ?? null,
          summary: `${moment.display_name ?? authorId ?? 'A public author'} appears in timeline but is not represented in life_state.relationships.`
        });
      }
    }
  }

  for (const community of communities) {
    mergeNode(nodes, {
      id: communityNodeId(community.community_id ?? community.id, community.name),
      kind: 'community',
      label: community.name ?? community.slug ?? community.community_id ?? 'community',
      sources: ['community_list'],
      evidence: {
        member_count: community.member_count ?? null,
        post_count: community.post_count ?? null,
        joined: community.joined ?? community.is_member ?? null
      }
    });
  }

  for (const post of communityPosts) {
    const communityId = communityNodeId(post.community_id, null);
    const authorId = post.author_id ?? post.citizen_id ?? null;
    const authorNodeId = authorId ? personNodeId('community_author', authorId, post.display_name) : null;
    if (authorNodeId) {
      mergeNode(nodes, {
        id: authorNodeId,
        kind: 'person',
        label: post.display_name ?? authorId,
        citizen_id: authorId,
        sources: ['community_post_author'],
        evidence: {
          recent_community_post_count: 1
        }
      });
    }
    const postNodeId = contentNodeId('community_post', post.post_id ?? post.id, post.created_at);
    mergeNode(nodes, {
      id: postNodeId,
      kind: 'community_post',
      label: sentenceClamp(post.title || post.text_preview || postNodeId, 80),
      sources: ['community_posts'],
      evidence: {
        community_id: post.community_id ?? null,
        created_at: post.created_at ?? null,
        reply_count: post.reply_count ?? null,
        authored_by_self: post.authored_by_self ?? null
      }
    });
    addEdge(edges, communityId, postNodeId, 'contains_post', { source: 'community_posts' });
    if (authorNodeId) {
      addEdge(edges, authorNodeId, postNodeId, 'authored_community_post', {
        source: 'community_posts',
        created_at: post.created_at ?? null
      });
      if (!post.authored_by_self && !knownRelationshipForPerson({ citizen_id: authorId, display_name: post.display_name }, keySets)) {
        gaps.push({
          severity: 'low',
          type: 'community_author_missing_relationship',
          node_id: authorNodeId,
          citizen_id: authorId,
          display_name: post.display_name ?? null,
          summary: `${post.display_name ?? authorId ?? 'A community author'} appears in community posts but is not represented in life_state.relationships.`
        });
      }
    }
  }

  const nodeList = Array.from(nodes.values());
  const edgeList = Array.from(edges.values());
  const personNodes = nodeList.filter((node) => node.kind === 'person' || node.kind === 'agent');
  const knownRelationshipNodes = nodeList.filter((node) => node.kind === 'person' && node.sources?.includes('life_state'));
  const observedOnlyPeople = personNodes.filter((node) => !node.sources?.includes('life_state') && node.kind !== 'agent');
  const attentionSignals = [
    ...attention,
    ...gaps.map((gap) => ({
      severity: gap.severity,
      topic: gap.type,
      node_id: gap.node_id,
      summary: gap.summary
    }))
  ];

  return {
    schema_version: 'stay_alive.relationship_graph.v1',
    generated_at: now.toISOString(),
    self_node_id: selfId,
    read_only: true,
    external_write: false,
    metrics: {
      node_count: nodeList.length,
      edge_count: edgeList.length,
      person_count: personNodes.length,
      known_relationship_count: relationships.length,
      known_relationship_node_count: knownRelationshipNodes.length,
      observed_only_person_count: observedOnlyPeople.length,
      friend_count: friends.length,
      moment_count: moments.length,
      community_count: communities.length,
      community_post_count: communityPosts.length,
      gap_count: gaps.length,
      attention_count: attentionSignals.length
    },
    nodes: nodeList,
    edges: edgeList,
    gaps,
    attention_signals: attentionSignals,
    recommended_next: observedOnlyPeople.length > 0
      ? 'Review observed-only people and decide which should become durable relationship notes.'
      : gaps.some((gap) => gap.type === 'relationship_missing_botland_id')
        ? 'Bind known relationships to BotLand citizen ids when reliable identity evidence appears.'
      : gaps.length > 0
        ? 'Review relationship graph gaps before turning them into durable memory.'
      : attention.length > 0
        ? 'Refresh stale relationship context through the next explicit interaction.'
        : 'Keep collecting low-frequency relationship evidence without increasing write autonomy.'
  };
}

export function relationshipGraphMemoryUpdate(lifeState, graph, source) {
  const metrics = graph.metrics ?? {};
  return {
    type: 'stay_alive_relationship_graph_summary',
    status: 'proposed',
    applies_to: {
      agent_id: lifeState.agent_id ?? null,
      generated_at: graph.generated_at,
      source
    },
    text: [
      `Relationship graph ${source} saw ${metrics.person_count ?? 0} person node(s), ${metrics.edge_count ?? 0} edge(s), and ${metrics.gap_count ?? 0} graph gap(s).`,
      `Observed-only people: ${metrics.observed_only_person_count ?? 0}.`,
      `Next: ${graph.recommended_next}`
    ].join(' '),
    evidence: {
      schema_version: graph.schema_version,
      node_count: metrics.node_count ?? 0,
      edge_count: metrics.edge_count ?? 0,
      person_count: metrics.person_count ?? 0,
      known_relationship_count: metrics.known_relationship_count ?? 0,
      observed_only_person_count: metrics.observed_only_person_count ?? 0,
      gap_count: metrics.gap_count ?? 0,
      gap_types: Array.from(new Set((graph.gaps ?? []).map((gap) => gap.type))).sort(),
      attention_topics: Array.from(new Set((graph.attention_signals ?? []).map((signal) => signal.topic))).sort()
    },
    apply_policy: 'operator_review_required'
  };
}

function candidateDispositionForGap(gap) {
  if (gap.type === 'friend_missing_life_state_relationship') {
    return {
      disposition: 'durable_note_candidate',
      confidence: 'medium',
      reason: 'BotLand friend evidence is stronger than one-off public visibility.'
    };
  }
  if (gap.type === 'relationship_missing_botland_id') {
    return {
      disposition: 'identity_binding_candidate',
      confidence: 'low',
      reason: 'Existing relationship note is missing a BotLand id; bind only after reliable identity evidence.'
    };
  }
  return {
    disposition: 'observation_only',
    confidence: 'low',
    reason: 'Public or community visibility alone is not enough to create a durable relationship note.'
  };
}

function relationshipCandidateKey(gap, source) {
  return [
    source,
    gap.type ?? 'relationship_gap',
    gap.citizen_id ?? gap.node_id ?? gap.display_name ?? 'unknown'
  ].map((part) => String(part).toLowerCase()).join(':');
}

export function relationshipGraphRelationshipUpdates(lifeState, graph, source, maxCandidates = 8) {
  const gaps = Array.isArray(graph.gaps) ? graph.gaps : [];
  return gaps.slice(0, maxCandidates).map((gap) => {
    const strategy = candidateDispositionForGap(gap);
    const displayName = gap.display_name ?? null;
    const targetHint = gap.citizen_id ?? displayName ?? gap.node_id ?? 'unknown';
    const shouldPromote = strategy.disposition === 'durable_note_candidate';
    return {
      type: 'stay_alive_relationship_candidate',
      status: 'proposed',
      applies_to: {
        agent_id: lifeState.agent_id ?? null,
        generated_at: graph.generated_at,
        source,
        graph_schema_version: graph.schema_version,
        graph_node_id: gap.node_id ?? null,
        candidate_key: relationshipCandidateKey(gap, source)
      },
      target: {
        citizen_id: gap.citizen_id ?? null,
        display_name: displayName,
        hint: targetHint
      },
      source_gap: {
        type: gap.type,
        severity: gap.severity ?? 'low',
        summary: gap.summary
      },
      disposition: strategy.disposition,
      confidence: strategy.confidence,
      promotion_allowed: shouldPromote,
      promotion_target: shouldPromote ? 'life_state.relationships' : null,
      recommendation: shouldPromote
        ? 'Review this candidate for a future durable relationship note; do not auto-promote.'
        : 'Keep this as observation evidence unless repeated interactions or explicit owner context appear.',
      text: `${displayName ?? targetHint} relationship graph candidate from ${source}: ${strategy.disposition}. ${strategy.reason}`,
      apply_policy: 'operator_review_required_local_candidate_only'
    };
  });
}
