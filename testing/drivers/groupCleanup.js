const { loadAccounts, request, getLogin } = require('./botlandClient');

const TEST_GROUP_PATTERNS = [
  /^Test Group\b/,
  /^Mention Group\b/,
  /^Typing Group\b/,
  /^Leave Group\b/,
  /^Disband Group\b/,
  /^List Groups Basic\b/,
  /^List Groups After Leave\b/,
  /^Get Group Basic\b/,
  /^Get Group After Disband\b/,
  /^History Group\b/,
  /^History Access Denied\b/,
  /^System Message Group\b/,
  /^Mute All Group\b/,
  /^Owner Send Muted Group\b/,
  /^Admin Role Group\b/,
  /^Admin Send Muted Group\b/,
  /^Remove Member Group\b/,
  /^Transfer Group\b/,
  /^UI Typing Group\b/,
  /^UI Mention Group\b/,
  /^UI Reaction Group\b/,
  /^UI System Message Group\b/,
  /^Disband Open Chat UI\b/,
  /^Leave Open Chat UI\b/,
  /^Disband Return List UI\b/,
  /^Leave Return List UI\b/,
];

function isTestGroup(group) {
  const name = String(group?.name || '');
  const description = String(group?.description || '');
  return TEST_GROUP_PATTERNS.some((pattern) => pattern.test(name)) || /^testing\b/i.test(description);
}

async function cleanupTestGroups({ logger = console } = {}) {
  const cfg = loadAccounts();
  const actors = Object.values(cfg.actors || {}).filter((actor) => actor?.handle && actor?.password);
  const log = logger?.log ? logger.log.bind(logger) : () => {};
  const warn = logger?.warn ? logger.warn.bind(logger) : log;
  const summary = { checkedActors: 0, matched: 0, disbanded: 0, left: 0, errors: [] };

  for (const actor of actors) {
    let login;
    try {
      login = await getLogin(cfg.baseUrl, actor.handle, actor.password);
    } catch (err) {
      summary.errors.push({ actor: actor.handle, action: 'login', error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    summary.checkedActors += 1;

    let groups;
    try {
      groups = await request(cfg.baseUrl, '/api/v1/groups', { token: login.access_token });
    } catch (err) {
      summary.errors.push({ actor: actor.handle, action: 'list', error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const group of Array.isArray(groups) ? groups : []) {
      if (!isTestGroup(group)) continue;
      summary.matched += 1;

      try {
        if (group.owner_id === actor.citizen_id) {
          await request(cfg.baseUrl, `/api/v1/groups/${encodeURIComponent(group.id)}`, {
            method: 'DELETE',
            token: login.access_token,
          });
          summary.disbanded += 1;
          log(`[cleanup] disbanded test group ${group.id} (${group.name})`);
        } else {
          await request(cfg.baseUrl, `/api/v1/groups/${encodeURIComponent(group.id)}/leave`, {
            method: 'POST',
            token: login.access_token,
          });
          summary.left += 1;
          log(`[cleanup] left test group ${group.id} (${group.name}) as ${actor.handle}`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        summary.errors.push({ actor: actor.handle, group_id: group.id, group_name: group.name, error });
        warn(`[cleanup] failed test group ${group.id} (${group.name}): ${error}`);
      }
    }
  }

  return summary;
}

module.exports = { cleanupTestGroups, isTestGroup, TEST_GROUP_PATTERNS };
