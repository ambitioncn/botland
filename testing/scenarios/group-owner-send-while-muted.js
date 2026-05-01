const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-owner-send-while-muted', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const member = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !member?.citizen_id) throw new Error('owner/member citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const memberLogin = await getLogin(cfg.baseUrl, member.handle, member.password, { force: true });

    const groupName = `Muted Owner Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [member.citizen_id], description: 'testing owner send while muted' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const muteResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/mute-all`, {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { muted: true },
    });
    result.details.muteResponse = muteResp;

    const recvWs = connectWS(cfg.wsUrl, memberLogin.access_token);
    await waitForOpen(recvWs);
    const sendWs = connectWS(cfg.wsUrl, ownerLogin.access_token);
    await waitForOpen(sendWs);
    result.details.connected = true;

    const received = [];
    recvWs.on('message', (buf) => {
      try { received.push(JSON.parse(String(buf))); } catch {}
    });

    const msgId = `owner_muted_probe_${Date.now()}`;
    const msgText = `owner muted pass probe ${Date.now()}`;
    send(sendWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: msgText },
    });
    result.details.sent = { id: msgId, text: msgText };

    await sleep(3500);

    const groupMsg = received.find(e => e.type === 'group.message.received' && e.id === msgId && e.to === groupId && e.payload?.text === msgText);
    result.details.receiverEvents = received.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));
    result.ok = !!groupMsg;

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
