const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-history-limit-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `History Limit Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group history limit' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);

    const sent = [];
    for (let i = 1; i <= 4; i++) {
      const id = `group_hist_limit_${Date.now()}_${i}`;
      const text = `group history limit probe ${i} ${Date.now()}`;
      send(sendWs, {
        type: 'group.message.send',
        id,
        to: groupId,
        payload: { content_type: 'text', text },
      });
      sent.push({ id, text });
      await sleep(400);
    }

    await sleep(1800);

    const history = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages?limit=2`, {
      token: receiverLogin.access_token,
    });

    const latestTwo = sent.slice(-2).reverse();
    const historyIds = Array.isArray(history) ? history.map(h => h.id) : [];
    const historyTexts = Array.isArray(history) ? history.map(h => h.payload?.text) : [];

    result.details.sent = sent;
    result.details.expectedLatestTwo = latestTwo;
    result.details.history = Array.isArray(history)
      ? history.map(h => ({ id: h.id, text: h.payload?.text, created_at: h.created_at }))
      : null;

    const countOk = Array.isArray(history) && history.length === 2;
    const orderOk = countOk && historyIds[0] === latestTwo[0].id && historyIds[1] === latestTwo[1].id;
    const textOk = countOk && historyTexts[0] === latestTwo[0].text && historyTexts[1] === latestTwo[1].text;

    result.ok = countOk && orderOk && textOk;

    console.log(JSON.stringify(result, null, 2));
    try { sendWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
