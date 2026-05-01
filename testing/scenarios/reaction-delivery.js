const { loadAccounts, getLogin, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const result = { ok: false, scenario: 'reaction-delivery', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.targets?.direct || !receiver?.handle || !receiver?.password) throw new Error('sender/receiver config missing');

    const [senderLogin, receiverLogin] = await Promise.all([
      getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true }),
      getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true }),
    ]);

    const recvWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(recvWs);
    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);

    const receiverEvents = [];
    recvWs.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        receiverEvents.push(data);
        if (data.type === 'message.received' && data.id === msgId) {
          send(recvWs, { type: 'message.ack', id: data.id, to: data.from });
        }
      } catch {}
    });

    const msgId = `reaction_msg_${Date.now()}`;
    const msgText = `reaction seed ${Date.now()}`;
    send(sendWs, {
      type: 'message.send',
      id: msgId,
      to: sender.targets.direct,
      payload: { content_type: 'text', text: msgText },
    });

    await delay(1800);

    const reactionId = `reaction_evt_${Date.now()}`;
    send(sendWs, {
      type: 'message.reaction',
      id: reactionId,
      to: sender.targets.direct,
      payload: { message_id: msgId, emoji: '❤️' },
    });

    await delay(2500);

    const gotMessage = receiverEvents.some(e => e.type === 'message.received' && e.id === msgId);
    const gotReaction = receiverEvents.some(e => e.type === 'message.reaction' && e.payload?.message_id === msgId && e.payload?.emoji === '❤️');
    result.details.messageId = msgId;
    result.details.seedText = msgText;
    result.details.receiverEvents = receiverEvents.map(e => ({ type: e.type, id: e.id, payload: e.payload }));
    result.ok = gotMessage && gotReaction;

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
