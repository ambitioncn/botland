const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function currentShortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'local';
  }
}

function createRunId({ date = new Date(), sha = currentShortSha() } = {}) {
  return `BT_TEST_${compactTimestamp(date)}_${sha}`;
}

function defaultRegistryPath(runId) {
  return path.join(__dirname, '..', 'artifacts', 'runs', runId, 'residue.json');
}

function emptyRegistry(runId, { baseUrl = '', startedAt = new Date().toISOString() } = {}) {
  return {
    run_id: runId,
    started_at: startedAt,
    base_url: baseUrl,
    objects: [],
    scenarios: [],
  };
}

function readRegistry(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

function initRegistry(file, runId, opts = {}) {
  const existing = readRegistry(file);
  if (existing?.run_id === runId) return existing;
  const registry = emptyRegistry(runId, opts);
  writeRegistry(file, registry);
  return registry;
}

function objectKey(obj) {
  return [
    obj.type || '',
    obj.id || '',
    obj.owner_handle || '',
    obj.actor_handle || '',
    obj.source || '',
  ].join('::');
}

function addObject(registry, obj) {
  if (!obj?.type || !obj?.id) return false;
  const normalized = {
    ...obj,
    id: String(obj.id),
    registered_at: obj.registered_at || new Date().toISOString(),
  };
  const key = objectKey(normalized);
  if (registry.objects.some((existing) => objectKey(existing) === key)) return false;
  registry.objects.push(normalized);
  return true;
}

function appendScenario(registry, scenario) {
  registry.scenarios.push({
    file: scenario.file,
    ok: !!scenario.ok,
    code: scenario.code,
    duration_ms: scenario.durationMs,
    scenario: scenario.parsed?.scenario || null,
    recorded_at: new Date().toISOString(),
  });
}

function findFirstObject(value, predicate) {
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstObject(item, predicate);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findFirstObject(item, predicate);
    if (found) return found;
  }
  return null;
}

function inferObjectsFromScenarioResult(result, runId) {
  const parsed = result?.parsed || {};
  const details = parsed.details || {};
  const scenarioName = parsed.scenario || result.file;
  const objects = [];

  const group =
    details.group ||
    findFirstObject(details, (obj) => (obj.id || obj.group_id || obj.groupId) && /group_/i.test(String(obj.id || obj.group_id || obj.groupId)));
  const groupId = details.groupId || details.group_id || group?.id || group?.group_id || group?.groupId;
  if (groupId) {
    objects.push({
      type: 'group',
      id: groupId,
      name: group?.name || details.groupName || details.group_name || '',
      source: scenarioName,
      run_id: runId,
    });
  }

  const sender = details.sender || {};
  const receiver = details.receiver || {};
  if (scenarioName === 'friend-request-dm-smoke' && sender.citizen_id && receiver.citizen_id) {
    objects.push({
      type: 'friendship',
      id: `${sender.citizen_id}:${receiver.citizen_id}`,
      from_id: sender.citizen_id,
      to_id: receiver.citizen_id,
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'manual',
    });
  }

  const requestId = details.request?.request_id || details.request_id;
  if (requestId) {
    objects.push({
      type: 'friend_request',
      id: requestId,
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'best_effort',
    });
  }

  const messageId = details.dm?.messageId || details.sent?.id || details.messageId || details.message_id;
  if (messageId) {
    objects.push({
      type: 'message',
      id: messageId,
      text: details.dm?.text || details.sent?.text || '',
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'audit_only',
    });
  }

  const citizenId = details.citizen_id || details.citizenId || details.registered?.citizen_id || details.auth?.citizen_id;
  if (citizenId && (scenarioName === 'auth-register-relogin-smoke' || /^BT_TEST_/.test(String(details.handle || '')))) {
    objects.push({
      type: 'citizen',
      id: citizenId,
      handle: details.handle || details.registered?.handle || '',
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'test_support_route',
    });
  }

  const reportId = details.report?.id || details.reportId || details.report_id;
  if (reportId) {
    objects.push({
      type: 'report',
      id: reportId,
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'test_support_route',
    });
  }

  const webhookId = details.webhook?.id || details.webhookId || details.webhook_id;
  if (webhookId) {
    objects.push({
      type: 'webhook',
      id: webhookId,
      source: scenarioName,
      run_id: runId,
    });
  }

  const pushToken = details.push?.token || details.pushToken || details.push_token;
  if (pushToken) {
    objects.push({
      type: 'push_token',
      id: pushToken,
      source: scenarioName,
      run_id: runId,
    });
  }

  const communityId = details.community?.id || details.communityId || details.community_id;
  if (communityId) {
    objects.push({
      type: 'community',
      id: communityId,
      name: details.community?.name || '',
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'test_support_route',
    });
  }

  const postId = details.post?.id || details.postId || details.post_id;
  if (postId) {
    objects.push({
      type: 'community_post',
      id: postId,
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'test_support_route',
    });
  }

  const replyId = details.reply?.id || details.replyId || details.reply_id;
  if (replyId) {
    objects.push({
      type: 'community_reply',
      id: replyId,
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'test_support_route',
    });
  }

  const momentId = details.moment?.id || details.momentId || details.moment_id;
  if (momentId) {
    objects.push({
      type: 'moment',
      id: momentId,
      source: scenarioName,
      run_id: runId,
      cleanup_policy: 'test_support_route',
    });
  }

  return objects;
}

function recordScenarioResult(file, runId, result, { registryPath = defaultRegistryPath(runId), baseUrl = '' } = {}) {
  const registry = initRegistry(registryPath, runId, { baseUrl });
  appendScenario(registry, { ...result, file });
  for (const obj of inferObjectsFromScenarioResult(result, runId)) addObject(registry, obj);
  writeRegistry(registryPath, registry);
  return registry;
}

module.exports = {
  addObject,
  createRunId,
  defaultRegistryPath,
  emptyRegistry,
  inferObjectsFromScenarioResult,
  initRegistry,
  readRegistry,
  recordScenarioResult,
  writeRegistry,
};
