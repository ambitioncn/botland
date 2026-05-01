const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const result = { ok: false, scenario: 'group-list-visibility-check', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `List Visibility Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group list visibility' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    await delay(1500);

    const senderList = await request(cfg.baseUrl, '/api/v1/groups', { token: senderLogin.access_token });
    const receiverList = await request(cfg.baseUrl, '/api/v1/groups', { token: receiverLogin.access_token });

    result.details.senderCount = Array.isArray(senderList) ? senderList.length : -1;
    result.details.receiverCount = Array.isArray(receiverList) ? receiverList.length : -1;
    result.details.senderHasGroup = Array.isArray(senderList) && senderList.some(g => g.id === groupId || g.name === groupName);
    result.details.receiverHasGroup = Array.isArray(receiverList) && receiverList.some(g => g.id === groupId || g.name === groupName);

    result.ok = !!result.details.senderHasGroup && !!result.details.receiverHasGroup;
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
