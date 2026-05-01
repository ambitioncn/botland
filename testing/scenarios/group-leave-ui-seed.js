const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-leave-ui-seed', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password, { force: true });

    const groupName = `Leave UI Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing leave ui visibility' },
    });
    const groupId = created.id;

    const beforeMember = await request(cfg.baseUrl, '/api/v1/groups', { token: memberLogin.access_token });
    const beforeVisible = Array.isArray(beforeMember) && beforeMember.some(g => g.id === groupId);

    const leaveResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });

    await sleep(1200);

    const afterMember = await request(cfg.baseUrl, '/api/v1/groups', { token: memberLogin.access_token });
    const afterVisible = Array.isArray(afterMember) && afterMember.some(g => g.id === groupId);

    result.details = {
      groupId,
      groupName,
      beforeVisible,
      leaveResponse: leaveResp,
      afterVisible,
    };

    result.ok = beforeVisible === true && leaveResp?.status === 'left' && afterVisible === false;
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
