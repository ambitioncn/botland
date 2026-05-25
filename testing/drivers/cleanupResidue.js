const { cleanupTestGroups } = require('./groupCleanup');
const { loadAccounts, request, getLogin } = require('./botlandClient');
const { defaultRegistryPath, readRegistry } = require('./residueRegistry');

function actorList(cfg) {
  return Object.values(cfg.actors || {}).filter((actor) => actor?.handle && actor?.password);
}

function isNotFoundOrForbidden(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(' 404 ') || message.includes(' 403 ');
}

function cleanupToken(cfg) {
  return cfg.testCleanupToken || process.env.BOTLAND_TEST_CLEANUP_TOKEN || '';
}

function objectKey(obj) {
  return `${obj.type || ''}::${obj.id || ''}`;
}

async function loginActors(cfg) {
  const logins = [];
  for (const actor of actorList(cfg)) {
    try {
      const login = await getLogin(cfg.baseUrl, actor.handle, actor.password);
      logins.push({ actor, login });
    } catch (err) {
      logins.push({ actor, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return logins;
}

async function deleteGroupWithAnyActor(cfg, logins, groupId, summary) {
  for (const entry of logins) {
    if (entry.error) continue;
    try {
      await request(cfg.baseUrl, `/api/v1/groups/${encodeURIComponent(groupId)}`, {
        method: 'DELETE',
        token: entry.login.access_token,
      });
      summary.groupsDeleted += 1;
      return true;
    } catch (err) {
      if (!isNotFoundOrForbidden(err)) {
        summary.errors.push({ type: 'group', id: groupId, actor: entry.actor.handle, action: 'delete', error: err.message });
      }
    }

    try {
      await request(cfg.baseUrl, `/api/v1/groups/${encodeURIComponent(groupId)}/leave`, {
        method: 'POST',
        token: entry.login.access_token,
      });
      summary.groupsLeft += 1;
      return true;
    } catch (err) {
      if (!isNotFoundOrForbidden(err)) {
        summary.errors.push({ type: 'group', id: groupId, actor: entry.actor.handle, action: 'leave', error: err.message });
      }
    }
  }
  return false;
}

async function deleteWebhookWithAnyActor(cfg, logins, webhookId, summary) {
  for (const entry of logins) {
    if (entry.error) continue;
    try {
      await request(cfg.baseUrl, `/api/v1/webhooks/${encodeURIComponent(webhookId)}`, {
        method: 'DELETE',
        token: entry.login.access_token,
      });
      summary.webhooksDeleted += 1;
      return true;
    } catch (err) {
      if (!isNotFoundOrForbidden(err)) {
        summary.errors.push({ type: 'webhook', id: webhookId, actor: entry.actor.handle, action: 'delete', error: err.message });
      }
    }
  }
  return false;
}

async function unregisterPushTokenWithAnyActor(cfg, logins, token, summary) {
  for (const entry of logins) {
    if (entry.error) continue;
    try {
      await request(cfg.baseUrl, '/api/v1/push/unregister', {
        method: 'POST',
        token: entry.login.access_token,
        body: { token },
      });
      summary.pushTokensUnregistered += 1;
      return true;
    } catch (err) {
      summary.errors.push({ type: 'push_token', id: token, actor: entry.actor.handle, action: 'unregister', error: err.message });
    }
  }
  return false;
}

function adminCleanupObjects(objects) {
  const supported = new Set([
    'group',
    'message',
    'event',
    'friend_request',
    'friendship',
    'report',
    'webhook',
    'push_token',
    'community',
    'community_post',
    'community_reply',
    'moment',
    'citizen',
  ]);
  return (objects || []).filter((obj) => obj?.type && obj?.id && supported.has(obj.type));
}

async function cleanupWithTestSupportRoute(cfg, registry, token) {
  const objects = adminCleanupObjects(registry.objects);
  if (objects.length === 0) return null;

  const res = await fetch(`${cfg.baseUrl}/api/v1/testing/cleanup-residue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Botland-Test-Cleanup-Token': token,
    },
    body: JSON.stringify({ run_id: registry.run_id, objects }),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(`test cleanup route failed: ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function cleanupResidue({ runId, registryPath, includePatternGroups = true, logger = console } = {}) {
  if (!runId && !registryPath) throw new Error('cleanupResidue requires runId or registryPath');
  const file = registryPath || defaultRegistryPath(runId);
  const registry = readRegistry(file) || { run_id: runId, objects: [] };
  const cfg = loadAccounts();
  const logins = await loginActors(cfg);
  const summary = {
    runId: registry.run_id || runId || null,
    registryPath: file,
    objectsSeen: registry.objects.length,
    groupsDeleted: 0,
    groupsLeft: 0,
    webhooksDeleted: 0,
    pushTokensUnregistered: 0,
    adminCleanup: null,
    skipped: [],
    errors: [],
    patternGroupCleanup: null,
  };
  const adminCleaned = new Set();

  const token = cleanupToken(cfg);
  if (token) {
    try {
      summary.adminCleanup = await cleanupWithTestSupportRoute(cfg, registry, token);
      for (const result of summary.adminCleanup?.results || []) {
        if (result.status === 'deleted' || result.status === 'not_found') {
          adminCleaned.add(`${result.type}::${result.id}`);
        } else if (result.status === 'error') {
          summary.errors.push({ type: result.type, id: result.id, action: result.action, error: result.error });
        }
      }
    } catch (err) {
      const status = err && typeof err === 'object' ? err.status : undefined;
      if (status !== 404) {
        summary.errors.push({ type: 'test_cleanup_route', action: 'cleanup', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  for (const obj of registry.objects) {
    if (adminCleaned.has(objectKey(obj))) continue;
    if (obj.type === 'group') {
      const cleaned = await deleteGroupWithAnyActor(cfg, logins, obj.id, summary);
      if (!cleaned) summary.skipped.push({ type: obj.type, id: obj.id, reason: 'not visible to configured actors or already removed' });
    } else if (obj.type === 'webhook') {
      const cleaned = await deleteWebhookWithAnyActor(cfg, logins, obj.id, summary);
      if (!cleaned) summary.skipped.push({ type: obj.type, id: obj.id, reason: 'not visible to configured actors or already removed' });
    } else if (obj.type === 'push_token') {
      const cleaned = await unregisterPushTokenWithAnyActor(cfg, logins, obj.id, summary);
      if (!cleaned) summary.skipped.push({ type: obj.type, id: obj.id, reason: 'unregister failed for all configured actors' });
    } else {
      summary.skipped.push({ type: obj.type, id: obj.id, reason: obj.cleanup_policy || 'no public cleanup API' });
    }
  }

  if (includePatternGroups) {
    summary.patternGroupCleanup = await cleanupTestGroups({ logger });
    if (Array.isArray(summary.patternGroupCleanup.errors)) {
      for (const err of summary.patternGroupCleanup.errors) {
        summary.errors.push({ type: 'pattern_group_cleanup', ...err });
      }
    }
  }

  return summary;
}

module.exports = { cleanupResidue };
