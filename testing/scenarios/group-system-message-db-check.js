const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-system-message-db-check', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password);
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password);

    const groupName = `System DB Check Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing system db check' },
    });
    const groupId = created.id;

    await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });

    await sleep(1200);

    const history = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages`, {
      token: ownerLogin.access_token,
    });

    result.details.groupId = groupId;
    result.details.count = Array.isArray(history) ? history.length : -1;
    result.details.messages = Array.isArray(history)
      ? history.map(h => ({ id: h.id, sender_id: h.sender_id, sender_name: h.sender_name, payload: h.payload }))
      : null;
    result.ok = Array.isArray(history) && history.some(h => h.payload?.content_type === 'system');
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
