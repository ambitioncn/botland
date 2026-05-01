const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'get-group-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `Get Group Basic ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing get group basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const senderView = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, { token: senderLogin.access_token });
    const receiverView = await request(cfg.baseUrl, `/api/v1/groups/${groupId}`, { token: receiverLogin.access_token });

    const senderOwner = senderView.members?.find(m => m.citizen_id === sender.citizen_id);
    const receiverMember = senderView.members?.find(m => m.citizen_id === receiver.citizen_id);

    result.details.senderView = {
      id: senderView.id,
      name: senderView.name,
      owner_id: senderView.owner_id,
      member_count: senderView.member_count,
      muted_all: senderView.muted_all,
      status: senderView.status,
      members: Array.isArray(senderView.members) ? senderView.members.map(m => ({ citizen_id: m.citizen_id, role: m.role, display_name: m.display_name })) : null,
    };
    result.details.receiverView = {
      id: receiverView.id,
      name: receiverView.name,
      owner_id: receiverView.owner_id,
      member_count: receiverView.member_count,
      muted_all: receiverView.muted_all,
      status: receiverView.status,
      members: Array.isArray(receiverView.members) ? receiverView.members.map(m => ({ citizen_id: m.citizen_id, role: m.role, display_name: m.display_name })) : null,
    };

    const baseOk = senderView.id === groupId && receiverView.id === groupId && senderView.name === groupName && receiverView.name === groupName;
    const countOk = senderView.member_count >= 2 && receiverView.member_count >= 2;
    const roleOk = senderOwner?.role === 'owner' && receiverMember?.role === 'member';
    const ownerOk = senderView.owner_id === sender.citizen_id && receiverView.owner_id === sender.citizen_id;

    result.ok = baseOk && countOk && roleOk && ownerOk;

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
