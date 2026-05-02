const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-leave-open-chat-seed', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password);
    const groupName = `Leave Open Chat UI ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing leave while chat open ui' },
    });
    const groupId = created.id;

    result.details = {
      groupId,
      groupName,
      memberHandle: member.handle,
      memberPassword: member.password,
    };

    result.ok = !!groupId && !!groupName;
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
