const { loadAccounts, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'offline-delivery', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.targets?.direct || !receiver?.handle || !receiver?.password) {
      throw new Error('sender/receiver config missing in accounts.local.json');
    }

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password);
    await sleep(2000);

    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);
    result.details.senderConnected = true;

    const msgId = `offline_probe_${Date.now()}`;
    const msgText = `offline delivery probe ${Date.now()}`;
    const senderSeen = [];
    sendWs.on('message', (buf) => {
      try { senderSeen.push(JSON.parse(String(buf))); } catch {}
    });

    send(sendWs, {
      type: 'message.send',
      id: msgId,
      to: sender.targets.direct,
      payload: { content_type: 'text', text: msgText },
    });
    result.details.sentWhileReceiverOffline = { id: msgId, text: msgText };

    await sleep(2000);

    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password);
    await sleep(2500);

    const recvWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(recvWs);
    result.details.receiverConnectedLater = true;

    const received = [];
    recvWs.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        received.push(data);
        if (data.type === 'message.received' && data.id === msgId) {
          send(recvWs, { type: 'message.ack', id: data.id, to: data.from });
        }
      } catch {}
    });

    await sleep(4500);

    const deliveredAfterReconnect = received.some(e => e.type === 'message.received' && e.id === msgId && e.payload?.text === msgText);
    const senderStatuses = senderSeen.filter(e => (e.type === 'message.status' || e.type === 'message.ack') && e.payload?.message_id === msgId).map(e => e.payload?.status);

    result.details.receiverEvents = received.map(e => ({ type: e.type, id: e.id, payload: e.payload }));
    result.details.senderStatuses = senderStatuses;
    result.details.readStatusObserved = senderStatuses.includes('read');
    result.ok = deliveredAfterReconnect;

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
