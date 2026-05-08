const { loadAccounts, getLogin, connectWS, waitForOpen, send, sleep, request } = require('../drivers/botlandClient');

function waitForMsg(recvWs, msgId, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    recvWs.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        if (data.id === msgId || (data.payload && data.payload.message_id === msgId)) {
          clearTimeout(timeout);
          resolve(data);
        }
      } catch {}
    });
  });
}

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
    sendWs.on('error', (err) => {
      result.details.senderWsError = err.message;
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
    let msgCount = 0;
    recvWs.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        msgCount++;
        received.push(data);
        if (data.type === 'message.received' && data.id === msgId) {
          send(recvWs, { type: 'message.ack', id: data.id, to: data.from });
        }
      } catch {}
    });
    recvWs.on('error', (err) => {
      result.details.recvWsError = err.message;
    });

    // Wait for the specific DM message (generous timeout for CI)
    const dmMsg = await waitForMsg(recvWs, msgId, 15000);
    const deliveredAfterReconnect = dmMsg !== null;
    result.details.dmMessageArrived = deliveredAfterReconnect;
    result.details.dmMessageType = dmMsg ? dmMsg.type : null;

    // Also wait extra time for read receipt to propagate
    await sleep(5000);

    const senderStatuses = senderSeen.filter(e => (e.type === 'message.status' || e.type === 'message.ack') && e.payload?.message_id === msgId).map(e => e.payload?.status);

    let historyFound = false;
    try {
      const history = await request(cfg.baseUrl, `/api/v1/messages/history?peer=${encodeURIComponent(sender.targets.direct)}&limit=50`, {
        token: receiverLogin.access_token,
      });
      const arr = Array.isArray(history) ? history : (Array.isArray(history?.messages) ? history.messages : []);
      historyFound = arr.some(m => m.id === msgId || m.payload?.text === msgText);
      result.details.historyCount = Array.isArray(arr) ? arr.length : -1;
    } catch (e) {
      result.details.historyCheckError = e instanceof Error ? e.message : String(e);
    }

    result.details.receiverEvents = received.map(e => ({ type: e.type, id: e.id, to: e.to, from: e.from, payload: e.payload }));
    result.details.senderStatuses = senderStatuses;
    result.details.readStatusObserved = senderStatuses.includes('read');
    result.details.historyFound = historyFound;
    result.details.totalReceivedMsgs = msgCount;
    result.ok = deliveredAfterReconnect || historyFound || senderStatuses.includes('read');

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
