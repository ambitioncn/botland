const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'get-group-after-disband', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password, { force: true });

    const groupName = `Get Group After Disband ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing get group after disband' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const beforeOwner = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, { token: ownerLogin.access_token });
    const beforeMember = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, { token: memberLogin.access_token });
    result.details.before = {
      ownerOk: !!beforeOwner?.id,
      memberOk: !!beforeMember?.id,
    };

    const disbandResponse = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, {
      method: 'DELETE',
      token: ownerLogin.access_token,
    });
    result.details.disbandResponse = disbandResponse;

    const after = {};
    for (const [label, token] of [['owner', ownerLogin.access_token], ['member', memberLogin.access_token]]) {
      try {
        const data = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, { token });
        after[label] = { ok: true, data };
      } catch (err) {
        after[label] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    result.details.after = after;

    const ownerErr = String(after.owner?.error || '');
    const memberErr = String(after.member?.error || '');
    result.ok =
      result.details.before.ownerOk === true &&
      result.details.before.memberOk === true &&
      result.details.disbandResponse?.status === 'disbanded' &&
      after.owner?.ok === false &&
      after.member?.ok === false &&
      ownerErr.includes('403') && ownerErr.includes('not a member') &&
      memberErr.includes('403') && memberErr.includes('not a member');

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
