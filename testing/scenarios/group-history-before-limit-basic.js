const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-history-before-limit-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password);
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password);

    const groupName = `History Before Limit Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group history before+limit' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);

    const sent = [];
    for (let i = 1; i <= 5; i++) {
      const id = `group_hist_before_limit_${Date.now()}_${i}`;
      const text = `group history before+limit probe ${i} ${Date.now()}`;
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

    const page1 = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages`, {
      token: receiverLogin.access_token,
    });
    const beforeId = page1?.[1]?.id;
    if (!beforeId) throw new Error('beforeId missing from page1');

    const history = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages?before=${beforeId}&limit=2`, {
      token: receiverLogin.access_token,
    });

    const expected = sent.slice(0, 3).reverse().slice(0, 2);

    result.details.sent = sent;
    result.details.page1 = Array.isArray(page1)
      ? page1.map(h => ({ id: h.id, text: h.payload?.text }))
      : null;
    result.details.beforeId = beforeId;
    result.details.expected = expected;
    result.details.history = Array.isArray(history)
      ? history.map(h => ({ id: h.id, text: h.payload?.text, created_at: h.created_at }))
      : null;

    const ids = Array.isArray(history) ? history.map(h => h.id) : [];
    const texts = Array.isArray(history) ? history.map(h => h.payload?.text) : [];
    const countOk = Array.isArray(history) && history.length === 2;
    const orderOk = countOk && ids[0] === expected[0].id && ids[1] === expected[1].id;
    const textOk = countOk && texts[0] === expected[0].text && texts[1] === expected[1].text;

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
