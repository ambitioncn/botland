const { loadAccounts, request, getLogin, connectWS, waitForOpen, send, sleep } = require('../drivers/botlandClient');

async function tryGetGroup(baseUrl, groupId, token) {
  try {
    const data = await request(baseUrl, `/api/v1/groups/${groupId}`, { token });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

(async () => {
  const result = { ok: false, scenario: 'group-transfer-owner-basic', details: {} };
  try {
    const cfg = loadAccounts();
    const oldOwner = cfg.actors.lobster_sender;
    const newOwner = cfg.actors.lobster_receiver;
    if (!oldOwner?.citizen_id || !newOwner?.citizen_id) throw new Error('owner/member citizen_id missing');

    const oldOwnerLogin = await getLogin(cfg.baseUrl, oldOwner.handle, oldOwner.password);
    const newOwnerLogin = await getLogin(cfg.baseUrl, newOwner.handle, newOwner.password);

    const groupName = `Transfer Group ${Date.now()}`;
    const created = await request(cfg.baseUrl, '/api/v1/groups', {
      method: 'POST',
      token: oldOwnerLogin.access_token,
      body: { name: groupName, member_ids: [newOwner.citizen_id], description: 'testing transfer owner basic' },
    });
    const groupId = created.id;
    result.details.group = { id: groupId, name: groupName };

    const beforeOld = await tryGetGroup(cfg.baseUrl, groupId, oldOwnerLogin.access_token);
    const beforeNew = await tryGetGroup(cfg.baseUrl, groupId, newOwnerLogin.access_token);
    result.details.before = { oldOwner: beforeOld, newOwner: beforeNew };

    const transferResp = await request(cfg.baseUrl, `/api/v1/groups/${groupId}/transfer`, {
      method: 'POST',
      token: oldOwnerLogin.access_token,
      body: { citizen_id: newOwner.citizen_id },
    });
    result.details.transferResponse = transferResp;

    const afterOld = await tryGetGroup(cfg.baseUrl, groupId, oldOwnerLogin.access_token);
    const afterNew = await tryGetGroup(cfg.baseUrl, groupId, newOwnerLogin.access_token);
    result.details.after = { oldOwner: afterOld, newOwner: afterNew };

    const oldWs = connectWS(cfg.wsUrl, oldOwnerLogin.access_token);
    await waitForOpen(oldWs);
    const newWs = connectWS(cfg.wsUrl, newOwnerLogin.access_token);
    await waitForOpen(newWs);
    result.details.connected = true;

    const oldOwnerEvents = [];
    const newOwnerEvents = [];
    oldWs.on('message', (buf) => { try { oldOwnerEvents.push(JSON.parse(String(buf))); } catch {} });
    newWs.on('message', (buf) => { try { newOwnerEvents.push(JSON.parse(String(buf))); } catch {} });

    const msgId = `transfer_probe_${Date.now()}`;
    const msgText = `new owner message probe ${Date.now()}`;
    send(newWs, {
      type: 'group.message.send',
      id: msgId,
      to: groupId,
      payload: { content_type: 'text', text: msgText },
    });

    await sleep(3500);

    const oldOwnerReceived = oldOwnerEvents.find(e => e.type === 'group.message.received' && e.id === msgId && e.to === groupId && e.payload?.text === msgText);
    const newOwnerGotError = newOwnerEvents.find(e => e.type === 'error');

    result.details.oldOwnerEvents = oldOwnerEvents.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));
    result.details.newOwnerEvents = newOwnerEvents.map(e => ({ type: e.type, id: e.id, to: e.to, payload: e.payload }));

    const afterNewOk = result.details.after.newOwner.ok;
    const afterOldOk = result.details.after.oldOwner.ok;
    result.ok = afterNewOk && afterOldOk && !!oldOwnerReceived && !newOwnerGotError;

    console.log(JSON.stringify(result, null, 2));
    try { oldWs.close(); } catch {}
    try { newWs.close(); } catch {}
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    result.details.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
})();
