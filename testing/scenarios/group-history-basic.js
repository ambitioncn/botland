const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-history-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password);
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password);

    const groupName = `History Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group history basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);

    const sent = [];
    for (let i = 1; i <= 3; i++) {
      const id = `group_hist_${Date.now()}_${i}`;
      const text = `group history probe ${i} ${Date.now()}`;
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

    const history = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages`, {
      token: receiverLogin.access_token,
    });

    const found = sent.map(m => ({
      id: m.id,
      found: Array.isArray(history) && history.some(h => h.id === m.id && h.payload?.text === m.text),
    }));

    result.details.sent = sent;
    result.details.historyCount = Array.isArray(history) ? history.length : -1;
    result.details.historySample = Array.isArray(history)
      ? history.slice(0, 5).map(h => ({ id: h.id, group_id: h.group_id, sender_id: h.sender_id, sender_name: h.sender_name, payload: h.payload, created_at: h.created_at }))
      : null;
    result.details.found = found;

    const allFound = found.every(f => f.found);
    const shapeOk = Array.isArray(history) && history.every(h => h.id && h.group_id === groupId && h.sender_id && h.payload && h.created_at);
    result.ok = Array.isArray(history) && history.length >= 3 && allFound && shapeOk;

    console.log(JSON.stringify(result, null, 2));
    try { sendWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
