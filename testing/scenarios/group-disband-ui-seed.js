const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-disband-ui-seed', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password, { force: true });

    const groupName = `Disband UI Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing disband ui visibility' },
    });
    const groupId = created.id;

    const beforeOwner = await request(cfg.baseUrl, '/api/v1/groups', { token: ownerLogin.access_token });
    const beforeMember = await request(cfg.baseUrl, '/api/v1/groups', { token: memberLogin.access_token });
    const beforeOwnerVisible = Array.isArray(beforeOwner) && beforeOwner.some(g => g.id === groupId);
    const beforeMemberVisible = Array.isArray(beforeMember) && beforeMember.some(g => g.id === groupId);

    const disbandResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, {
      method: 'DELETE',
      token: ownerLogin.access_token,
    });

    await sleep(1200);

    const afterOwner = await request(cfg.baseUrl, '/api/v1/groups', { token: ownerLogin.access_token });
    const afterMember = await request(cfg.baseUrl, '/api/v1/groups', { token: memberLogin.access_token });
    const afterOwnerVisible = Array.isArray(afterOwner) && afterOwner.some(g => g.id === groupId);
    const afterMemberVisible = Array.isArray(afterMember) && afterMember.some(g => g.id === groupId);

    result.details = {
      groupId,
      groupName,
      beforeOwnerVisible,
      beforeMemberVisible,
      disbandResponse: disbandResp,
      afterOwnerVisible,
      afterMemberVisible,
    };

    result.ok =
      beforeOwnerVisible === true &&
      beforeMemberVisible === true &&
      disbandResp?.status === 'disbanded' &&
      afterOwnerVisible === false &&
      afterMemberVisible === false;

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
