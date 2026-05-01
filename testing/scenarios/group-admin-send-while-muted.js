const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

(async () => {
  const result = { ok: false, scenario: 'group-admin-send-while-muted', details: {} };
  try {
    const cfg = loadAccounts();
    const owner = cfg.actors.lobster_sender;
    const adminUser = cfg.actors.lobster_receiver;
    if (!owner?.citizen_id || !adminUser?.citizen_id) throw new Error('owner/admin citizen_id missing');

    const ownerLogin = await getLogin(cfg.baseUrl, owner.handle, owner.password, { force: true });
    const adminLogin = await getLogin(cfg.baseUrl, adminUser.handle, adminUser.password, { force: true });

    const groupName = `Muted Admin Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { name: groupName, member_ids: [adminUser.citizen_id], description: 'testing admin send while muted' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const promoteResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/members/${adminUser.citizen_id}/role`, {
      method: 'PUT',
      token: ownerLogin.access_token,
      body: { role: 'admin' },
    });
    result.details.promoteResponse = promoteResp;

    const muteResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/mute-all`, {
      method: 'POST',
      token: ownerLogin.access_token,
      body: { muted: true },
    });
    result.details.muteResponse = muteResp;

    const ownerWs = connectWS(cfg.wsUrl, ownerLogin.access_token);
    await waitForOpen(ownerWs);
    const adminWs = connectWS(cfg.wsUrl, adminLogin.access_token);
    await waitForOpen(adminWs);
    result.details.connected = true;

    const ownerEvents = [];
    const adminEvents = [];
    ownerWs.on('message', (buf) => { try { ownerEvents.push(JSON.parse(String(buf))); } catch {} });
    adminWs.on('message', (buf) => { try { adminEvents.push(JSON.parse(String(buf))); } catch {} });

    const msgId = `admin_muted_probe_${Date.now()}`;
    const msgText = `admin muted pass probe ${Date.now()}`;
    send(adminWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: msgText },
    });

    await sleep(3500);

    const ownerReceived = ownerEvents.find(e => e.type === 'group.message.received' && e.id === msgId && e.to === groupId && e.payload?.text === msgText);
    const adminError = adminEvents.find(e => e.type === 'error');
    const adminDelivered = adminEvents.find(e => e.type === 'message.status' && e.payload?.message_id === msgId && e.payload?.status === 'delivered');

    result.details.ownerEvents = ownerEvents.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));
    result.details.adminEvents = adminEvents.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));
    result.ok = !!ownerReceived && !adminError && !!adminDelivered;

    console.log(JSON.stringify(result, null, 2));
    try { ownerWs.close(); } catch {}
    try { adminWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
