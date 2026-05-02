const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

async function tryGetGroup(baseUrl, groupId, token) {
  try {
    const data = await request(baseUrl, `/api/v1/groups/${groupId}`, { token });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

(async () => {
  const result = { ok: false, scenario: 'group-admin-role-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password);
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password);

    const groupName = `Admin Role Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing admin role basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const before = await tryGetGroup(cfg.baseUrl, groupId, ownerLogin.access_token);
    result.details.before = before;

    const promoteResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/members/${member.citizen_id}/role`, {
      method: 'PUT',
      token: ownerLogin.access_token,
      body: { role: 'admin' },
    });
    result.details.promoteResponse = promoteResp;

    const afterPromote = await tryGetGroup(cfg.baseUrl, groupId, ownerLogin.access_token);
    result.details.afterPromote = afterPromote;

    const demoteResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/members/${member.citizen_id}/role`, {
      method: 'PUT',
      token: ownerLogin.access_token,
      body: { role: 'member' },
    });
    result.details.demoteResponse = demoteResp;

    const afterDemote = await tryGetGroup(cfg.baseUrl, groupId, ownerLogin.access_token);
    result.details.afterDemote = afterDemote;

    const promoted = afterPromote.ok && afterPromote.data.members.some(m => m.citizen_id === member.citizen_id && m.role === 'admin');
    const demoted = afterDemote.ok && afterDemote.data.members.some(m => m.citizen_id === member.citizen_id && m.role === 'member');
    result.ok = promoted && demoted;

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
