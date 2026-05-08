const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-typing-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password);
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password);

    const groupName = `Typing Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group typing basic' },
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
    recvWs.on('error', (err) => {
      result.details.recvWsError = err.message;
    });

    // Wait for any group setup events (member.joined, group_created) to arrive
    await sleep(3000);

    send(sendWs, { type: 'group.typing.start', to: groupId });
    await sleep(2000);
    send(sendWs, { type: 'group.typing.stop', to: groupId });
    result.details.sent = true;

    // Wait for typing events to arrive at receiver (increased from 3000ms to 6000ms for CI)
    await sleep(6000);

    const typingStart = received.find(e => e.type === 'group.typing.start' && e.to === groupId && e.from === sender.citizen_id);
    const typingStop = received.find(e => e.type === 'group.typing.stop' && e.to === groupId && e.from === sender.citizen_id);

    result.details.receiverEvents = received.map(e => ({ type: e.type, from: e.from, to: e.to, payload: e.payload }));
    result.details.totalReceivedMsgs = received.length;
    result.ok = !!typingStart && !!typingStop;

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
