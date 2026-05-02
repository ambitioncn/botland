const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-history-access-denied', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password);
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password);

    const groupName = `History Access Denied ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing history access denied' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const leaveResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/leave`, {
      method: 'POST',
      token: memberLogin.access_token,
    });
    result.details.leaveResponse = leaveResp;

    try {
      await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages`, {
        token: memberLogin.access_token,
      });
      result.details.historyAccess = { ok: true };
    } catch (err) {
      result.details.historyAccess = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    result.ok = result.details.leaveResponse?.status === 'left' && result.details.historyAccess?.ok === false && String(result.details.historyAccess?.error || '').includes('403') && String(result.details.historyAccess?.error || '').includes('not a member');

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
