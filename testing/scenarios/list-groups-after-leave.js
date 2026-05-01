const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'list-groups-after-leave', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password, { force: true });

    const groupName = `List Groups After Leave ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing list groups after leave' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const beforeOwner = await request(cfg.baseUrl, '/api/v1/groups', { token: ownerLogin.access_token });
    const beforeMember = await request(cfg.baseUrl, '/api/v1/groups', { token: memberLogin.access_token });
    result.details.before = {
      ownerHasGroup: Array.isArray(beforeOwner) && beforeOwner.some(g => g.id === groupId),
      memberHasGroup: Array.isArray(beforeMember) && beforeMember.some(g => g.id === groupId),
    };

    const leaveResponse = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });
    result.details.leaveResponse = leaveResponse;

    const afterOwner = await request(cfg.baseUrl, '/api/v1/groups', { token: ownerLogin.access_token });
    const afterMember = await request(cfg.baseUrl, '/api/v1/groups', { token: memberLogin.access_token });
    result.details.after = {
      ownerHasGroup: Array.isArray(afterOwner) && afterOwner.some(g => g.id === groupId),
      memberHasGroup: Array.isArray(afterMember) && afterMember.some(g => g.id === groupId),
    };

    result.ok =
      result.details.before.ownerHasGroup === true &&
      result.details.before.memberHasGroup === true &&
      result.details.leaveResponse?.status === 'left' &&
      result.details.after.ownerHasGroup === true &&
      result.details.after.memberHasGroup === false;

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
