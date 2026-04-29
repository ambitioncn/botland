const { loadAccounts, login, connectWS, waitForOpen, send } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'typing-relay-check', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.targets?.direct || !receiver?.handle || !receiver?.password || receiver.password === 'CHANGE_ME') {
      throw new Error('sender target or receiver credentials missing in accounts.local.json');
    }

    const [senderLogin, receiverLogin] = await Promise.all([
      login(cfg.baseUrl, sender.handle, sender.password),
      login(cfg.baseUrl, receiver.handle, receiver.password),
    ]);
    result.details.sender = senderLogin.citizen_id;
    result.details.receiver = receiverLogin.citizen_id;

    const recvWs = connectWS(cfg.wsUrl, receiverLogin.access_token);
    await waitForOpen(recvWs);
    result.details.receiverConnected = true;

    let received = [];
    recvWs.on('message', (buf) => {
      try {
        const data = JSON.parse(String(buf));
        received.push({ type: data.type, from: data.from, to: data.to, payload: data.payload });
      } catch {}
    });

    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);
    result.details.senderConnected = true;

    send(sendWs, { type: 'typing.start', to: sender.targets.direct });
    setTimeout(() => send(sendWs, { type: 'typing.stop', to: sender.targets.direct }), 1200);
    result.details.sent = true;

    setTimeout(() => {
      const typingEvents = received.filter((e) => e.type === 'typing.start' || e.type === 'typing.stop');
      result.details.received = received;
      result.details.typingEvents = typingEvents;
      result.ok = typingEvents.length > 0;
      console.log(JSON.stringify(result, null, 2));
      try { sendWs.close(); } catch {}
      try { recvWs.close(); } catch {}
      process.exit(result.ok ? 0 : 1);
    }, 4000);
  } catch (err) {
    result.ok = false;
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
