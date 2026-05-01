const { loadAccounts, login, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const result = { ok: false, scenario: 'dm-delivery-ack', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.targets?.direct || !receiver?.handle || !receiver?.password) {
      throw new Error('sender/receiver config missing in accounts.local.json');
    }

    const [senderLogin, receiverLogin] = await Promise.all([
      login(cfg.baseUrl, sender.handle, sender.password),
      login(cfg.baseUrl, receiver.handle, receiver.password),
    ]);

    result.details.sender = senderLogin.citizen_id;
    result.details.receiver = receiverLogin.citizen_id;

    const recvWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(recvWs);
    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);
    result.details.connected = true;

    const received = [];
    const senderSeen = [];
    const msgText = `dm delivery ack probe ${Date.now()}`;
    const msgId = `probe_dm_${Date.now()}`;

    recvWs.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        received.push(data);
        if (data.type === 'message.received' && data.id === msgId) {
          send(recvWs, { type: 'message.ack', id: data.id, to: data.from });
        }
      } catch {}
    });

    sendWs.on('message', (buf) => {
      try { senderSeen.push(JSON.parse(String(buf))); } catch {}
    });

    send(sendWs, {
      type: 'message.send',
      id: msgId,
      to: sender.targets.direct,
      payload: { content_type: 'text', text: msgText },
    });
    result.details.sent = { id: msgId, text: msgText };

    await delay(4000);

    const deliveredToReceiver = received.some(e => e.type === 'message.received' && e.id === msgId && e.payload?.text === msgText);
    const senderStatuses = senderSeen.filter(e => (e.type === 'message.status' || e.type === 'message.ack') && e.payload?.message_id === msgId).map(e => e.payload?.status);

    result.details.receiverEvents = received.map(e => ({ type: e.type, id: e.id, payload: e.payload }));
    result.details.senderStatuses = senderStatuses;
    result.ok = deliveredToReceiver && senderStatuses.includes('delivered') && senderStatuses.includes('read');

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
