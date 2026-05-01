const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-mention-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password);
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password);

    const groupName = `Mention Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group mention basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const recvWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(recvWs);
    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);
    result.details.connected = true;

    const received = [];
    recvWs.on('message', (buf) => {
      try { received.push(JSON.parse(String(buf))); } catch {}
    });

    const msgId = `group_mention_probe_${Date.now()}`;
    const msgText = `hello @${receiver.ui_name || 'receiver'} from probe`;
    const mentions = [{ citizen_id: receiver.citizen_id, display_name: receiver.ui_name || 'receiver', offset: 6 }];
    send(sendWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: msgText, mentions },
    });
    result.details.sent = { id: msgId, text: msgText, mentions };

    await sleep(3500);

    const groupMsg = received.find(e => e.type === 'group.message.received' && e.id === msgId && e.to === groupId);
    const gotMentions = Array.isArray(groupMsg?.payload?.mentions) ? groupMsg.payload.mentions : [];
    const mentionedReceiver = gotMentions.some(m => m?.citizen_id === receiver.citizen_id);

    result.details.receiverEvents = received.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));
    result.details.observedMentions = gotMentions;
    result.ok = !!groupMsg && mentionedReceiver;

    console.log(JSON.stringify(result, null, 2));
    try { sendWs.close(); } catch {}
    try { recvWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
