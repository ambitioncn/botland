const { loadAccounts, request, getLogin, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const result = { ok: false, scenario: 'group-mention-seed', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `UI Mention Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group mention ui' },
    });
    const groupId = created.id;

    const recvWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(recvWs);
    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);

    const msgId = `group_mention_ui_${Date.now()}`;
    const msgText = `hello @${receiver.ui_name || 'receiver'} from ui probe`;
    const mentions = [{ citizen_id: receiver.citizen_id, display_name: receiver.ui_name || 'receiver', offset: 6 }];

    send(sendWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: msgText, mentions },
    });

    await delay(1500);

    result.ok = true;
    result.details.groupId = groupId;
    result.details.groupName = groupName;
    result.details.messageId = msgId;
    result.details.messageText = msgText;
    result.details.mentionDisplay = receiver.ui_name || 'receiver';
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
