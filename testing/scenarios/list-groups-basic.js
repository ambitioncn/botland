const { loadAccounts, request, getLogin, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'list-groups-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `List Groups Basic ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing list groups basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    await sleep(1200);

    const senderList = await request(cfg.baseUrl, '/api/v1/groups', { token: senderLogin.access_token });
    const receiverList = await request(cfg.baseUrl, '/api/v1/groups', { token: receiverLogin.access_token });

    const senderGroup = Array.isArray(senderList) ? senderList.find(g => g.id === groupId) : null;
    const receiverGroup = Array.isArray(receiverList) ? receiverList.find(g => g.id === groupId) : null;

    result.details.senderCount = Array.isArray(senderList) ? senderList.length : -1;
    result.details.receiverCount = Array.isArray(receiverList) ? receiverList.length : -1;
    result.details.senderGroup = senderGroup ? {
      id: senderGroup.id,
      name: senderGroup.name,
      owner_id: senderGroup.owner_id,
      member_count: senderGroup.member_count,
      muted_all: senderGroup.muted_all,
      status: senderGroup.status,
    } : null;
    result.details.receiverGroup = receiverGroup ? {
      id: receiverGroup.id,
      name: receiverGroup.name,
      owner_id: receiverGroup.owner_id,
      member_count: receiverGroup.member_count,
      muted_all: receiverGroup.muted_all,
      status: receiverGroup.status,
    } : null;

    const shapeOk = (g) => g && g.id === groupId && g.name === groupName && g.owner_id === sender.citizen_id && g.member_count >= 2 && g.status === 'active';
    result.ok = shapeOk(senderGroup) && shapeOk(receiverGroup);

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
