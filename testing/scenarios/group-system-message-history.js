const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-system-message-history', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password);
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password);

    const groupName = `System History Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing system message history' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const leaveResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });
    result.details.leaveResponse = leaveResp;

    await sleep(1200);

    const history = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages`, {
      token: ownerLogin.access_token,
    });

    const systemMsg = Array.isArray(history)
      ? history.find(h => h.payload?.content_type === 'system' && h.payload?.event === 'member_left')
      : null;

    result.details.historyCount = Array.isArray(history) ? history.length : -1;
    result.details.systemSample = systemMsg
      ? {
          id: systemMsg.id,
          group_id: systemMsg.group_id,
          sender_id: systemMsg.sender_id,
          sender_name: systemMsg.sender_name,
          payload: systemMsg.payload,
          created_at: systemMsg.created_at,
        }
      : null;

    result.ok = !!systemMsg && !!systemMsg.payload?.text && !!systemMsg.payload?.actor_id && systemMsg.payload?.event === 'member_left';

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
