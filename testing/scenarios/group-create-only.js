const { loadAccounts, request, getLogin } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-create-only', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password);
    const groupName = `UI Typing Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group typing ui' },
    });

    result.ok = true;
    result.details.groupId = created.id;
    result.details.groupName = groupName;
    result.details.senderName = sender.ui_name || '忘了鸭';
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
