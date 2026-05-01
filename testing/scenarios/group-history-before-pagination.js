const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-history-before-pagination', details: {} };
  try {
    const cfg = loadAccounts();
    const sender = cfg.actors.lobster_sender;
    const receiver = cfg.actors.lobster_receiver;
    if (!sender?.citizen_id || !receiver?.citizen_id) throw new Error('sender/receiver citizen_id missing');

    const senderLogin = await getLogin(cfg.baseUrl, sender.handle, sender.password, { force: true });
    const receiverLogin = await getLogin(cfg.baseUrl, receiver.handle, receiver.password, { force: true });

    const groupName = `History Page Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: senderLogin.access_token,
      body: { name: groupName, member_ids: [receiver.citizen_id], description: 'testing group history pagination' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const sendWs = connectWS(cfg.wsUrl, senderLogin.access_token);
    await waitForOpen(sendWs);

    const sent = [];
    for (let i = 1; i <= 4; i++) {
      const id = `group_hist_page_${Date.now()}_${i}`;
      const text = `group history page probe ${i} ${Date.now()}`;
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
    const page2 = beforeId
      ? await request(cfg.baseUrl, `/api/v1/groups/${groupId}/messages?before=${encodeURIComponent(beforeId)}`, {
          token: receiverLogin.access_token,
        })
      : [];

    result.details.sent = sent;
    result.details.page1 = Array.isArray(page1) ? page1.map(h => ({ id: h.id, text: h.payload?.text })) : null;
    result.details.beforeId = beforeId;
    result.details.page2 = Array.isArray(page2) ? page2.map(h => ({ id: h.id, text: h.payload?.text })) : null;

    const page1Ids = Array.isArray(page1) ? page1.map(h => h.id) : [];
    const page2Ids = Array.isArray(page2) ? page2.map(h => h.id) : [];

    const beforeNotInPage2 = beforeId ? !page2Ids.includes(beforeId) : false;
    const expectedOlderIds = sent.slice(0, 2).map(m => m.id);
    const page2ContainsOlder = expectedOlderIds.every(id => page2Ids.includes(id));

    result.ok = Array.isArray(page1) && page1.length >= 2 && Array.isArray(page2) && page2.length >= 1 && beforeNotInPage2 && page2ContainsOlder;

    console.log(JSON.stringify(result, null, 2));
    try { sendWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
