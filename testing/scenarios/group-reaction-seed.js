const { loadAccounts, request, getLogin, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const result = { ok: false, scenario: 'group-reaction-seed', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `UI Reaction Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group reaction ui' },
    });
    const groupId = created.id;

    const recvWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(recvWs);
    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);

    const msgId = `group_reaction_ui_${Date.now()}`;
    const msgText = `group reaction seed ${Date.now()}`;
    send(sendWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: msgText },
    });

    await delay(1500);

    result.ok = true;
    result.details.groupId = groupId;
    result.details.groupName = groupName;
    result.details.messageId = msgId;
    result.details.messageText = msgText;
    console.log(JSON.stringify(result, null, 2));
    try { sendWs.close(); } catch {}
    try { recvWs.close(); } catch {}
    process.exit(0);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
