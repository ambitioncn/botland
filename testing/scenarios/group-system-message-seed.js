const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-system-message-seed', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password);
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password);

    const groupName = `System Message UI Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing group system message ui' },
    });
    const groupId = created.id;

    const leaveResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });

    await sleep(1500);

    const history = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages`, {
      token: ownerLogin.access_token,
    });

    const systemMsg = Array.isArray(history)
      ? history.find(h => h.payload?.content_type === 'system' && h.payload?.event === 'member_left')
      : null;

    result.details = {
      groupId,
      groupName,
      leaveResponse: leaveResp,
      systemText: systemMsg?.payload?.text || null,
      systemEvent: systemMsg?.payload?.event || null,
      actorName: systemMsg?.payload?.actor_name || member.ui_name || member.display_name || 'Nick is king',
    };

    result.ok = !!groupId && !!groupName && leaveResp?.status === 'left' && !!result.details.systemText;
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
